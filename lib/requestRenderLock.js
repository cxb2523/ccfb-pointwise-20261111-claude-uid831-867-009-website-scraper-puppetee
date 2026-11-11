/**
 * Keeps plain HTTP requests and puppeteer page renders from overlapping.
 *
 * A page render may rotate session cookies (via js or Set-Cookie), which
 * invalidates the cookie an in-flight plain request was built with. So:
 * - requests run concurrently with each other, but never while a render
 *   is running or waiting to run;
 * - a render runs alone: it waits for in-flight requests to finish and
 *   does not overlap with other renders, which could invalidate each other.
 */
class RequestRenderLock {
	constructor () {
		this.requests = 0;
		this.renders = 0; // running or waiting
		this.rendering = false;
		this.waiting = [];
	}

	/**
	 * Resolves when a request may start. Returns a function to call once it finished.
	 */
	async startRequest () {
		while (this.renders > 0) {
			await this.wait();
		}
		this.requests++;
		return once(() => {
			this.requests--;
			this.notify();
		});
	}

	/**
	 * Resolves when a render may start. Returns a function to call once it finished.
	 */
	async startRender () {
		this.renders++;
		while (this.requests > 0 || this.rendering) {
			await this.wait();
		}
		this.rendering = true;
		return once(() => {
			this.rendering = false;
			this.renders--;
			this.notify();
		});
	}

	wait () {
		return new Promise(resolve => this.waiting.push(resolve));
	}

	notify () {
		const waiting = this.waiting;
		this.waiting = [];
		waiting.forEach(resolve => resolve());
	}
}

/**
 * The single request decision used by every render, including the no-lock
 * (exclusiveRendering: false) mode, so a page never gets two competing
 * interception handlers.
 *
 * The pending counter is incremented for every intercepted request and
 * released on both requestfinished and requestfailed: aborted requests
 * finish as failures rather than successes, so without the failure branch
 * networkidle waits would hang until the goto timeout.
 */
function createRequestInterceptor (blockResourceTypes = []) {
	const blockedTypes = new Set(blockResourceTypes);
	const interceptor = {
		pending: 0,
		aborted: 0,
		continued: 0,
		abandoned: 0,
		log: []
	};

	interceptor.onRequest = request => {
		const type = request.resourceType();
		// documents are validated out of blockResourceTypes in the plugin
		// constructor, keep a guard here so a navigation can never be blanked
		const blocked = type !== 'document' && blockedTypes.has(type);

		interceptor.pending++;
		interceptor.log.push({ type, url: request.url(), blocked });

		if (blocked) {
			interceptor.aborted++;
			request.abort().catch(() => {
				// the page or target may already be gone (navigation away, page close)
			});
		} else {
			interceptor.continued++;
			request.continue().catch(() => {
				// the page or target may already be gone (navigation away, page close)
			});
		}
	};

	// no clamping: a negative counter means request/finish events are unbalanced,
	// which assertDrained() below must surface instead of hiding it
	const release = () => {
		interceptor.pending--;
	};
	interceptor.onRequestFinished = release;
	interceptor.onRequestFailed = release;

	interceptor.assertDrained = () => {
		if (interceptor.pending !== 0) {
			throw new Error(`request render lock: ${interceptor.pending} intercepted request(s) did not finish`);
		}
	};

	// page.close() terminates every in-flight request, but some of them (e.g.
	// a continued request whose server never responded, like a hanging favicon)
	// emit neither requestfinished nor requestfailed. The page teardown is their
	// terminal event, so reconcile them here instead of leaving the counter stuck.
	interceptor.drainAbandoned = () => {
		interceptor.abandoned += interceptor.pending;
		interceptor.pending = 0;
		return interceptor.abandoned;
	};

	return interceptor;
}

/**
 * Turns interception on for a page and wires the interceptor as the only
 * request handler. The returned detach function removes the listeners and
 * disables interception again; it is safe to call after the page was closed.
 */
async function attachInterception (page, options = {}) {
	const interceptor = createRequestInterceptor(options.blockResourceTypes);

	await page.setRequestInterception(true);
	page.on('request', interceptor.onRequest);
	page.on('requestfinished', interceptor.onRequestFinished);
	page.on('requestfailed', interceptor.onRequestFailed);

	const detach = once(async () => {
		page.off('request', interceptor.onRequest);
		page.off('requestfinished', interceptor.onRequestFinished);
		page.off('requestfailed', interceptor.onRequestFailed);
		// runs after page.close(): reconcile requests which got no terminal event
		interceptor.drainAbandoned();
		// resolves without error even when the page was already closed
		await page.setRequestInterception(false);
	});

	return { interceptor, detach };
}

function once (fn) {
	let called = false;
	return () => {
		if (!called) {
			called = true;
			fn();
		}
	};
}

export default RequestRenderLock;
export { createRequestInterceptor, attachInterception };
