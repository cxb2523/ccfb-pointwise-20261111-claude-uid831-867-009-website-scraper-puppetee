/**
 * Validation and merging of the plugin options related to page.goto and
 * request interception. Kept separate from the plugin so the rules can be
 * unit-tested without launching a browser.
 */

// resourceType() values reported by puppeteer, lower-cased CDP Network.ResourceType
export const RESOURCE_TYPES = [
	'document',
	'stylesheet',
	'image',
	'media',
	'font',
	'script',
	'texttrack',
	'xhr',
	'fetch',
	'prefetch',
	'eventsource',
	'websocket',
	'manifest',
	'signedexchange',
	'ping',
	'cspviolationreport',
	'preflight',
	'fedcm',
	'other'
];

// legal values of puppeteer page.goto waitUntil
export const WAIT_UNTIL_EVENTS = [
	'load',
	'domcontentloaded',
	'networkidle0',
	'networkidle2'
];

/**
 * blockResourceTypes must be an array of known puppeteer resource types;
 * "document" is rejected explicitly because aborting the navigation request
 * leaves the page blank. Returns the validated array.
 */
export function validateBlockResourceTypes (blockResourceTypes) {
	if (!Array.isArray(blockResourceTypes)) {
		throw new TypeError('PuppeteerPlugin: blockResourceTypes must be an array of resource type names');
	}

	for (const type of blockResourceTypes) {
		if (typeof type !== 'string' || RESOURCE_TYPES.indexOf(type) === -1) {
			throw new TypeError(`PuppeteerPlugin: unknown resource type ${JSON.stringify(type)} in blockResourceTypes, valid values are: ${RESOURCE_TYPES.join(', ')}`);
		}
		if (type === 'document') {
			throw new TypeError('PuppeteerPlugin: resource type "document" cannot be blocked, aborting the navigation request would leave the page blank');
		}
	}

	return blockResourceTypes;
}

/**
 * waitUntil must be one of the puppeteer lifecycle events (or an array of
 * them), see https://pptr.dev/api/puppeteer.puppeteerlifecycleevent
 */
export function validateWaitUntil (waitUntil) {
	if (waitUntil === undefined) {
		return;
	}

	const values = Array.isArray(waitUntil) ? waitUntil : [waitUntil];
	for (const value of values) {
		if (typeof value !== 'string' || WAIT_UNTIL_EVENTS.indexOf(value) === -1) {
			throw new TypeError(`PuppeteerPlugin: invalid waitUntil value ${JSON.stringify(value)}, valid values are: ${WAIT_UNTIL_EVENTS.join(', ')}`);
		}
	}
}

/**
 * timeout is passed through to page.goto: a positive number limits the
 * navigation in milliseconds, 0 disables the timeout completely.
 */
export function validateTimeout (timeout) {
	if (timeout === undefined) {
		return;
	}

	if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout < 0) {
		throw new TypeError('PuppeteerPlugin: timeout must be a non-negative number of milliseconds, use 0 to disable the timeout');
	}
}

/**
 * Builds the final page.goto options. The dedicated waitUntil/timeout plugin
 * options take precedence over gotoOptions entries; everything else from
 * gotoOptions is passed through untouched, so callers which only use
 * gotoOptions keep their exact current behavior.
 */
export function buildGotoOptions (gotoOptions, waitUntil, timeout) {
	const merged = Object.assign({}, gotoOptions);

	if (waitUntil !== undefined) {
		merged.waitUntil = waitUntil;
	}
	if (timeout !== undefined) {
		merged.timeout = timeout;
	}

	validateWaitUntil(merged.waitUntil);
	validateTimeout(merged.timeout);

	return merged;
}
