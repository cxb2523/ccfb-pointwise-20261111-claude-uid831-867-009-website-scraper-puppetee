import { expect } from 'chai';
import http from 'http';
import path from 'path';
import { pathToFileURL } from 'url';
import finalhandler from 'finalhandler';
import serveStatic from 'serve-static';
import fs from 'fs-extra';
import scrape from 'website-scraper';
import puppeteer, { TimeoutError } from '@website-scraper/puppeteer-version-wrapper';
import PuppeteerPlugin from '../lib/index.js';
import { createRequestInterceptor } from '../lib/requestRenderLock.js';

const directory = './test/tmp';
const SERVE_WEBSITE_PORT = 4567;
const SLOW_WEBSITE_PORT = 4570;
const blockedResourcesUrl = pathToFileURL(path.resolve('./test/mock/blocked-resources.html')).href;

describe('Puppeteer plugin test', () => {
	let result, content, server;

	before('start webserver', () => server = startWebserver(SERVE_WEBSITE_PORT));
	after('stop webserver', () => server.close())

	describe('Dynamic content', () => {
		before('scrape website', async () => {
			result = await scrape({
				urls: [`http://localhost:${SERVE_WEBSITE_PORT}`],
				directory: directory,
				plugins: [ new PuppeteerPlugin({
					scrollToBottom: { timeout: 50, viewportN: 10 }
				}) ]
			});
		});
		before('get content from file', () => {
			content = fs.readFileSync(`${directory}/${result[0].filename}`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should have 1 item in result array', () => {
			expect(result.length).eql(1);
		});

		it('should render dymanic website', async () => {
			expect(content).to.contain('<div id="root">Hello world from JS!</div>');
		});

		it('should render special characters correctly', async () => {
			expect(content).to.contain('<div id="special-characters-test">7년 동안 한국에서 살았어요. Слава Україні!</div>');
		});
	});

	// Regression test for https://github.com/website-scraper/website-scraper-puppeteer/issues/115
	// The page js rotates the session cookie; the rotated cookie must be used
	// for subsequent requests instead of the initially configured one.
	// Runs with the default (unlimited) requestConcurrency: page renders
	// must not overlap with each other or with in-flight plain requests.
	describe('Session cookie rotated by page js', () => {
		const SESSION_SERVER_PORT = 4568;
		let sessionServer, files;

		before('start session webserver', () => sessionServer = startSessionRotatingWebserver(SESSION_SERVER_PORT));
		after('stop session webserver', () => sessionServer.close());

		before('scrape website', async () => {
			await scrape({
				urls: [`http://localhost:${SESSION_SERVER_PORT}/`],
				directory: directory,
				recursive: true,
				request: {
					headers: { Cookie: 'session=token-1' }
				},
				urlFilter: url => url.startsWith(`http://localhost:${SESSION_SERVER_PORT}`),
				plugins: [ new PuppeteerPlugin({
					// wait for the session-rotating fetch() to complete before the page is closed
					gotoOptions: { waitUntil: 'networkidle0' }
				}) ]
			});
		});
		before('get content from files', () => {
			files = {};
			for (const name of ['index', 'page2', 'page3', 'page4', 'page5']) {
				files[name] = fs.readFileSync(`${directory}/${name}.html`).toString();
			}
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should stay logged in on the first page', () => {
			expect(files.index).to.contain('LOGGED-IN');
		});

		it('should stay logged in on subsequent pages', () => {
			for (const name of ['page2', 'page3', 'page4', 'page5']) {
				expect(files[name], name).to.contain('LOGGED-IN');
			}
		});

		it('should never present a stale token', () => {
			expect(sessionServer.sessionDestroyed).to.eql(false);
		});

		it('should use the rotated cookie for subsequent website-scraper requests', () => {
			const scraperRequests = sessionServer.requestLog.filter(request => request.url === '/page2.html' && !request.fromBrowser);
			expect(scraperRequests).to.have.lengthOf(1);
			expect(scraperRequests[0].cookie).to.eql('session=token-2');
		});
	});

	// got follows redirects internally, so cookies set on intermediate hops
	// are only visible through the cookie jar - not in the final response.
	describe('Cookie set on a redirect hop', () => {
		const REDIRECT_SERVER_PORT = 4569;
		let redirectServer, homeContent;

		before('start redirecting webserver', () => redirectServer = startRedirectingWebserver(REDIRECT_SERVER_PORT));
		after('stop redirecting webserver', () => redirectServer.close());

		before('scrape website', async () => {
			await scrape({
				urls: [`http://localhost:${REDIRECT_SERVER_PORT}/`],
				directory: directory,
				request: {
					headers: { Cookie: 'session=token-1' }
				},
				plugins: [ new PuppeteerPlugin() ]
			});
		});
		before('get content from file', () => {
			homeContent = fs.readFileSync(`${directory}/index.html`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should send the configured cookie to the redirecting url', () => {
			const requests = redirectServer.requestLog.filter(request => request.url === '/' && !request.fromBrowser);
			expect(requests).to.have.lengthOf(1);
			expect(requests[0].cookie).to.eql('session=token-1');
		});

		it('should send the cookie set by the redirect to the redirect target', () => {
			const requests = redirectServer.requestLog.filter(request => request.url === '/home.html' && !request.fromBrowser);
			expect(requests).to.have.lengthOf(1);
			expect(requests[0].cookie).to.eql('session=token-2');
		});

		it('should render the redirect target in puppeteer with the cookie set by the redirect', () => {
			expect(homeContent).to.contain('<h1>session=token-2</h1>');
		});

		it('should ignore a cookie rejected by the browser', () => {
			// the scrape completed (see before hook) despite the __Secure- cookie
			// sent over http, and the valid cookie was kept
			expect(homeContent).to.contain('<h1>session=token-2</h1>');
		});
	});

	describe('exclusiveRendering: false', () => {
		let plainResult, plainContent;

		before('scrape website', async () => {
			plainResult = await scrape({
				urls: [`http://localhost:${SERVE_WEBSITE_PORT}`],
				directory: directory,
				plugins: [ new PuppeteerPlugin({ exclusiveRendering: false }) ]
			});
		});
		before('get content from file', () => {
			plainContent = fs.readFileSync(`${directory}/${plainResult[0].filename}`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		it('should render dynamic website without the render lock', () => {
			expect(plainContent).to.contain('<div id="root">Hello world from JS!</div>');
		});
	});

	describe('CJK content with charset only in meta tag', () => {
		let cjkResult, cjkContent;

		before('scrape website', async () => {
			cjkResult = await scrape({
				urls: [`http://localhost:${SERVE_WEBSITE_PORT}/cjk.html`],
				directory: directory,
				plugins: [ new PuppeteerPlugin() ]
			});
		});
		before('get content from file', () => {
			cjkContent = fs.readFileSync(`${directory}/${cjkResult[0].filename}`).toString();
		});
		after('delete dir', () => fs.removeSync(directory));

		// Regression test for https://github.com/website-scraper/website-scraper-puppeteer/pull/103
		// Saving the page as a binary string corrupted these characters on disk.
		it('should save CJK characters without corruption', () => {
			expect(cjkContent).to.contain('<div id="cjk-characters-test">磁致伸缩位移传感器 影响大跨度桥梁施工控制的因素</div>');
		});
	});

	describe('Plugin option validation', () => {
		it('should reject "document" in blockResourceTypes', () => {
			expect(() => new PuppeteerPlugin({ blockResourceTypes: ['image', 'document'] }))
				.to.throw(/document/);
		});

		it('should reject unknown resource type names', () => {
			expect(() => new PuppeteerPlugin({ blockResourceTypes: ['flac'] }))
				.to.throw(/unknown resource type/);
		});

		it('should reject a non-array blockResourceTypes', () => {
			expect(() => new PuppeteerPlugin({ blockResourceTypes: 'image' }))
				.to.throw(TypeError);
		});

		it('should reject illegal waitUntil values, also inside gotoOptions', () => {
			expect(() => new PuppeteerPlugin({ waitUntil: 'forever' }))
				.to.throw(/invalid waitUntil/);
			expect(() => new PuppeteerPlugin({ gotoOptions: { waitUntil: 'nope' } }))
				.to.throw(/invalid waitUntil/);
		});

		it('should accept an array of legal waitUntil values', () => {
			const plugin = new PuppeteerPlugin({ waitUntil: ['domcontentloaded', 'networkidle2'] });
			expect(plugin.gotoOptions.waitUntil).to.eql(['domcontentloaded', 'networkidle2']);
		});

		it('should pass timeout 0 through as "no timeout"', () => {
			const plugin = new PuppeteerPlugin({ timeout: 0 });
			expect(plugin.gotoOptions.timeout).to.eql(0);
		});

		it('should reject negative and non-numeric timeouts', () => {
			expect(() => new PuppeteerPlugin({ timeout: -1 })).to.throw(TypeError);
			expect(() => new PuppeteerPlugin({ timeout: '100' })).to.throw(TypeError);
		});

		it('should keep gotoOptions untouched when the new options are omitted', () => {
			const plugin = new PuppeteerPlugin({ gotoOptions: { waitUntil: 'networkidle0' } });
			expect(plugin.gotoOptions).to.eql({ waitUntil: 'networkidle0' });
			expect(plugin.blockResourceTypes).to.eql([]);
		});
	});

	describe('Request interceptor', () => {
		function fakeRequest (type) {
			return {
				type,
				aborted: false,
				continued: false,
				resourceType () {
					return this.type;
				},
				url () {
					return `http://example.com/${this.type}`;
				},
				abort () {
					this.aborted = true;
					return Promise.resolve();
				},
				continue () {
					this.continued = true;
					return Promise.resolve();
				}
			};
		}

		it('should abort blocked types and continue every other request, documents included', () => {
			const interceptor = createRequestInterceptor(['image', 'font']);
			const documentRequest = fakeRequest('document');
			const imageRequest = fakeRequest('image');
			const fontRequest = fakeRequest('font');
			const scriptRequest = fakeRequest('script');

			interceptor.onRequest(documentRequest);
			interceptor.onRequest(imageRequest);
			interceptor.onRequest(fontRequest);
			interceptor.onRequest(scriptRequest);

			expect(documentRequest.continued).to.eql(true);
			expect(scriptRequest.continued).to.eql(true);
			expect(imageRequest.aborted).to.eql(true);
			expect(fontRequest.aborted).to.eql(true);
			expect(interceptor.aborted).to.eql(2);
			expect(interceptor.continued).to.eql(2);
			expect(interceptor.pending).to.eql(4);
		});

		it('should never abort a document even when it is listed', () => {
			const interceptor = createRequestInterceptor(['document']);
			const request = fakeRequest('document');

			interceptor.onRequest(request);

			expect(request.continued).to.eql(true);
			expect(request.aborted).to.eql(false);
		});

		it('should release the pending counter on requestfailed as well as requestfinished', () => {
			const interceptor = createRequestInterceptor(['image']);

			interceptor.onRequest(fakeRequest('image'));
			expect(interceptor.pending).to.eql(1);
			interceptor.onRequestFailed();
			expect(interceptor.pending).to.eql(0);

			interceptor.onRequest(fakeRequest('script'));
			interceptor.onRequestFinished();
			expect(interceptor.pending).to.eql(0);
		});

		it('should assert while an intercepted request did not finish', () => {
			const interceptor = createRequestInterceptor(['image']);
			interceptor.onRequest(fakeRequest('image'));

			expect(() => interceptor.assertDrained()).to.throw(/did not finish/);

			interceptor.onRequestFailed();
			interceptor.assertDrained();
		});

		it('should reconcile requests which got no terminal event on teardown', () => {
			const interceptor = createRequestInterceptor([]);
			interceptor.onRequest(fakeRequest('other'));
			interceptor.onRequest(fakeRequest('document'));
			interceptor.onRequestFinished();

			expect(interceptor.pending).to.eql(1);
			const abandoned = interceptor.drainAbandoned();

			expect(abandoned).to.eql(1);
			expect(interceptor.abandoned).to.eql(1);
			interceptor.assertDrained();
		});

		it('should swallow a rejected abort/continue when the target is already gone', async () => {
			const interceptor = createRequestInterceptor(['image']);
			const abortedRequest = fakeRequest('image');
			abortedRequest.abort = () => Promise.reject(new Error('target closed'));
			const continuedRequest = fakeRequest('script');
			continuedRequest.continue = () => Promise.reject(new Error('target closed'));

			interceptor.onRequest(abortedRequest);
			interceptor.onRequest(continuedRequest);
			await new Promise(resolve => setTimeout(resolve, 0));

			expect(interceptor.aborted).to.eql(1);
			expect(interceptor.continued).to.eql(1);
		});
	});

	describe('Resource type blocking', () => {
		let browser;

		before('launch browser', async () => {
			browser = await puppeteer.launch();
		});
		after('close browser', () => browser.close());

		it('should abort blocked resource types and continue all other requests', async () => {
			const plugin = new PuppeteerPlugin({ blockResourceTypes: ['image', 'stylesheet'] });
			plugin.browser = browser;

			const { body } = await plugin.renderPage(blockedResourcesUrl);
			const { interceptor } = plugin;

			// every intercepted request got exactly one outcome
			expect(interceptor.aborted + interceptor.continued).to.eql(interceptor.log.length);

			const abortedTypes = interceptor.log
				.filter(entry => entry.blocked)
				.map(entry => entry.type)
				.sort();
			const continuedTypes = interceptor.log
				.filter(entry => !entry.blocked)
				.map(entry => entry.type)
				.sort();
			expect(abortedTypes).to.eql(['image', 'stylesheet']);
			expect(continuedTypes).to.eql(['document', 'script']);

			// aborts finish via requestfailed, so the pending counter must be drained
			// by the failure listener rather than the teardown reconciliation
			expect(interceptor.pending).to.eql(0);
			expect(interceptor.abandoned).to.eql(0);

			// the document still rendered and the non-blocked script still executed
			expect(body).to.contain('resource blocking page');
			expect(body).to.contain('script loaded');
		});

		// aborted requests fire requestfailed instead of requestfinished; without
		// releasing the pending counter on failures, networkidle0 waits hang until
		// the goto timeout
		it('should settle a networkidle0 wait despite aborted requests', async () => {
			const plugin = new PuppeteerPlugin({
				blockResourceTypes: ['image', 'stylesheet'],
				waitUntil: 'networkidle0'
			});
			plugin.browser = browser;

			await plugin.renderPage(blockedResourcesUrl);
			expect(plugin.interceptor.pending).to.eql(0);
			expect(plugin.interceptor.abandoned).to.eql(0);
		});
	});

	describe('goto timeout', () => {
		let slowServer, browser;

		before('start slow webserver', () => slowServer = startSlowDocumentWebserver(SLOW_WEBSITE_PORT));
		after('stop slow webserver', () => slowServer.close());
		before('launch browser', async () => {
			browser = await puppeteer.launch();
		});
		after('close browser', () => browser.close());

		it('should reject with a TimeoutError and release the pending request', async () => {
			const plugin = new PuppeteerPlugin({ timeout: 100, waitUntil: 'load' });
			plugin.browser = browser;

			const error = await plugin.renderPage(`http://localhost:${SLOW_WEBSITE_PORT}/`)
				.then(() => null, caughtError => caughtError);

			expect(error).to.be.instanceOf(TimeoutError);
			// the document request was continued, only the server response was slow
			expect(plugin.interceptor.continued).to.eql(1);
			// page.close() aborts the in-flight document and the requestfailed
			// listener releases the counter, so nothing relies on the teardown
			// reconciliation and no request is left pending
			expect(plugin.interceptor.abandoned).to.eql(0);
			expect(plugin.interceptor.pending).to.eql(0);
		});
	});
});

// Simulates a website which rotates the session cookie via an ajax call
// (like WordPress heartbeat / WooCommerce fragments do). Rotation invalidates
// the previous token, and presenting a stale token destroys the whole session
// (like WordPress security plugins do on suspected session hijacking).
// Pages link to each other so that sibling pages get requested concurrently:
// index -> page2, page3; page2 -> page4; page3 -> page5.
function startSessionRotatingWebserver (port) {
	const validTokens = new Set(['token-1']);
	const seenTokens = new Set(['token-1']);
	let tokenCounter = 1;
	const requestLog = [];
	const links = {
		'/': ['/page2.html', '/page3.html'],
		'/page2.html': ['/page4.html'],
		'/page3.html': ['/page5.html']
	};

	const server = http.createServer((req, res) => {
		if (req.url === '/favicon.ico') {
			// requested by Chrome in parallel with the page's own requests, not session-related
			res.writeHead(404).end();
			return;
		}
		// Every request takes a while to be processed, so requests sent concurrently
		// (by a page render or by website-scraper) overlap and a rotation triggered
		// by one of them lands before the others are validated.
		setTimeout(() => handle(req, res), 100);
	});

	function handle (req, res) {
		const fromBrowser = (req.headers['user-agent'] || '').includes('HeadlessChrome');
		const tokenMatch = (req.headers.cookie || '').match(/session=([^;]+)/);
		const token = tokenMatch ? tokenMatch[1] : null;

		requestLog.push({
			url: req.url,
			cookie: req.headers.cookie || null,
			// requests made by the puppeteer page vs by website-scraper itself
			fromBrowser
		});

		if (token && seenTokens.has(token) && !validTokens.has(token)) {
			validTokens.clear(); // stale token reuse -> destroy session
			server.sessionDestroyed = true;
		}
		const loggedIn = token && validTokens.has(token);

		if (req.url === '/refresh') {
			if (loggedIn) {
				validTokens.delete(token);
				const newToken = `token-${++tokenCounter}`;
				validTokens.add(newToken);
				seenTokens.add(newToken);
				res.setHeader('Set-Cookie', `session=${newToken}; Path=/`);
			}
			res.setHeader('Content-Type', 'application/json');
			res.end(JSON.stringify({ ok: loggedIn }));
			return;
		}

		res.setHeader('Content-Type', 'text/html');
		const status = loggedIn ? 'LOGGED-IN' : 'LOGGED-OUT';
		const anchors = (links[req.url] || []).map(href => `<a href="${href}">${href}</a>`).join('');
		res.end(`<html><body><h1>${status}</h1>
			${anchors}
			<script>fetch('/refresh');</script>
		</body></html>`);
	}

	server.requestLog = requestLog;
	server.sessionDestroyed = false;
	return server.listen(port);
}

// Simulates a website which sets a new session cookie while redirecting
// (like login flows do): GET / -> 302 Location: /home.html + Set-Cookie.
function startRedirectingWebserver (port) {
	const requestLog = [];

	const server = http.createServer((req, res) => {
		requestLog.push({
			url: req.url,
			cookie: req.headers.cookie || null,
			fromBrowser: (req.headers['user-agent'] || '').includes('HeadlessChrome')
		});

		if (req.url === '/') {
			res.writeHead(302, { 'Location': '/home.html', 'Set-Cookie': 'session=token-2; Path=/' });
			res.end();
			return;
		}

		res.setHeader('Content-Type', 'text/html');
		// __Secure- prefixed cookies must have the Secure attribute, Chrome rejects this one
		res.setHeader('Set-Cookie', '__Secure-tracking=1; Path=/');
		res.end(`<html><body><h1>${req.headers.cookie || 'no cookie'}</h1></body></html>`);
	});

	server.requestLog = requestLog;
	return server.listen(port);
}

function startWebserver(port = 3000) {
	const serve = serveStatic('./test/mock', {'index': ['index.html']});
	const server = http.createServer(function onRequest (req, res) {
		// Serve the CJK page the same way as the website from #103: utf-8 is
		// declared only in the html <meta> tag, not in the Content-Type header.
		if (req.url === '/cjk.html') {
			res.setHeader('Content-Type', 'text/html');
			res.end(fs.readFileSync('./test/mock/cjk.html'));
			return;
		}
		serve(req, res, finalhandler(req, res))
	});

	return server.listen(port)
}

// Accepts and continues the request immediately but holds the document
// response, so a page.goto with a tiny timeout fails while the request
// itself stays in flight until the page is closed.
function startSlowDocumentWebserver (port) {
	const heldResponses = [];
	const server = http.createServer((req, res) => {
		heldResponses.push(res);
	});

	server.on('close', () => {
		for (const res of heldResponses) {
			if (!res.writableEnded) {
				res.destroy();
			}
		}
	});

	return server.listen(port);
}
