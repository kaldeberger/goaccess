/*jshint sub:true*/
(function () {
'use strict';

// Syntactic sugar
function $(selector) {
	return document.querySelector(selector);
}

// Syntactic sugar & execute callback
function $$(selector, callback) {
	var elems = document.querySelectorAll(selector);
	for (var i = 0; i < elems.length; ++i) {
		if (callback && typeof callback == 'function')
			callback.call(this, elems[i]);
	}
}

var debounce = function (func, wait, now) {
	var timeout;
	return function debounced () {
		var that = this, args = arguments;
		function delayed() {
			if (!now)
				func.apply(that, args);
			timeout = null;
		}
		if (timeout) {
			clearTimeout(timeout);
		} else if (now) {
			func.apply(obj, args);
		}
		timeout = setTimeout(delayed, wait || 250);
	};
};

// global namespace
window.GoAccess = window.GoAccess || {
	initialize: function (options) {
		this.opts = options;
		var cw = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0);

		this.AppState = {};
		this.AppTpls = {};
		this.AppCharts = {};
		this.AppUIData = (this.opts || {}).uiData || {};
		// Reorder panel UI items so DATA dimension is always first (leftmost column)
		for (var p in this.AppUIData) {
			if (this.AppUIData[p] && Array.isArray(this.AppUIData[p].items)) {
				var pItems = this.AppUIData[p].items;
				var dIdx = pItems.findIndex(function (it) { return it.key === 'data'; });
				if (dIdx > 0) {
					var dItem = pItems.splice(dIdx, 1)[0];
					dItem.colWidth = "auto";
					pItems.unshift(dItem);
				}
			}
		}
		this.AppData = (this.opts || {}).panelData || {};
		this.AppWSConn = (this.opts || {}).wsConnection || {};
		this.i18n = (this.opts || {}).i18n || {};
		this.AppPrefs = {
			'autoHideTables': true,
			'layout': 'horizontal',
			'panelOrder': [],
			'perPage': 7,
			'theme': (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'darkGray' : 'bright',
			'hiddenPanels': [],
		};
		this.AppPrefs = GoAccess.Util.merge(this.AppPrefs, this.opts.prefs);
		this.currentJWT = null;
		this.csrfToken = null;
		this.authInvalidated = false;
		this.tokenRefreshTimer = null;

		// WebSocket reconnection settings
		this.wsDelay = this.currDelay = 1E3;
		this.maxDelay = 20E3;
		this.retries = 0;
		this.maxRetries = 20;
		this.tokenRefreshLeadTime = 60;

		this.handleLocalStorage();
		this.isAppInitialized = false;

		// Initialize message rotation
		this.startMessageRotation();

		// Handle WebSocket setup
		this.handleWebSocketSetup();
	},

	handleLocalStorage: function () {
		// Check if the browser supports localStorage
		if (!GoAccess.Util.hasLocalStorage()) {
			return;
		}

		try {
			const ls = JSON.parse(localStorage.getItem('AppPrefs'));
			if (!ls || typeof ls !== 'object') {
				return;  // Invalid data, use defaults
			}

			// Validate critical properties maintain their expected types
			if (ls.hiddenPanels && !Array.isArray(ls.hiddenPanels)) {
				throw new Error('hiddenPanels is not an array');
			}
			if (ls.panelOrder && !Array.isArray(ls.panelOrder)) {
				throw new Error('panelOrder is not an array');
			}

			// Merge stored preferences into the current application preferences
			this.AppPrefs = GoAccess.Util.merge(this.AppPrefs, ls);
		} catch (e) {
			// Old or corrupted preferences detected, discard them
			localStorage.removeItem('AppPrefs');
			// AppPrefs retains new defaults
		}
	},

	setStatusMessage: function (msg) {
		var el = $('.app-loading-status > small');
		if (el) el.innerHTML = msg;
	},

	hideSpinner: function () {
		var el = $('.loading-container > .spinner') || $('.spinner');
		if (el) el.style.display = 'none';
	},

	startMessageRotation: function () {
		// Define the messages that will be displayed during the loading process
		const messages = [
			'Fetching authentication token... Please wait.',
			'Validating WebSocket tokens... Please wait.',
			'Authenticating WebSocket connection... Please wait.',
			'Verifying WebSocket credentials... Please wait.',
			'Authorizing WebSocket session... Please wait.'
		];
		let currentMessageIndex = 0; // Tracks the index of the currently displayed message
		// Set up an interval to rotate through the messages
		this.messageInterval = setInterval(() => {
			if (currentMessageIndex < messages.length) {
				this.setStatusMessage(messages[currentMessageIndex]);
				currentMessageIndex++;
			}
		}, 500);
	},

	handleWebSocketSetup: function () {
		// Fetch and authenticate the JWT using the provided WebSocket auth URL (external JWT)
		if (this.AppWSConn.ws_auth_url) {
			this.fetchAndAuthenticateJWT();
		}
		// If a JWT exists or WebSocket configuration is provided
		else if (window.goaccessJWT || Object.keys(this.AppWSConn).length) {
			// Set up the WebSocket connection using the existing JWT
			this.setWebSocket(this.AppWSConn, window.goaccessJWT, this.messageInterval);
		}  else {
			// Initialize the application without WebSocket authentication
			this.initializeWithoutWebSocket();
		}
	},

	fetchAndAuthenticateJWT: function () {
		// Attempt to fetch a JWT from the WebSocket authentication URL
		this.fetchJWT(this.AppWSConn.ws_auth_url)
			.then(data => {
				if (data.status === "success") {
					// Extract the JWT, refresh token, and expiration time from the response
					const jwt = data.access_token;
					const refreshToken = data.refresh_token;
					const expiresIn = data.expires_in;
					// Set up the WebSocket connection using the fetched JWT
					this.setWebSocket(this.AppWSConn, jwt, this.messageInterval);
					// Schedule automatic token refresh before it expires
					this.scheduleTokenRefresh(expiresIn, refreshToken);
				} else {
					// Handle failure response from the authentication server
					this.handleAuthenticationFailure(data.message);
				}
			})
			.catch(error => {
				// Handle errors during the JWT fetch process
				this.handleAuthenticationError(error);
			});
	},

	initializeWithoutWebSocket: function () {
		// Stop the message rotation interval
		clearInterval(this.messageInterval);
		this.setStatusMessage('No authentication provided.');
		// Proceed to initialize the app without WebSocket support
		GoAccess.App.initialize();
		this.isAppInitialized = true;
	},

	handleAuthenticationFailure: function (message) {
		// Stop the message rotation interval
		clearInterval(this.messageInterval);
		this.setStatusMessage(`Authentication failed: ${message}`);
		this.hideSpinner();
	},

	handleAuthenticationError: function (error) {
		// Stop the message rotation interval
		clearInterval(this.messageInterval);
		this.setStatusMessage('Error fetching authentication token.');
	},

	getPanelUI: function (panel) {
		return panel ? this.AppUIData[panel] : this.AppUIData;
	},

	getPrefs: function (panel) {
		return panel ? this.AppPrefs[panel] : this.AppPrefs;
	},

	setPrefs: function () {
		if (GoAccess.Util.hasLocalStorage()) {
			localStorage.setItem('AppPrefs', JSON.stringify(GoAccess.getPrefs()));
		}
	},

	getPanelData: function (panel) {
		return panel ? this.AppData[panel] : this.AppData;
	},

	// Include cookies for session validation
	fetchJWT: function (url) {
		return fetch(url, {
			method: 'GET',
			credentials: 'include',
			headers: { 'Accept': 'application/json' },
			referrerPolicy: 'no-referrer-when-downgrade'
		})
		.then(response => response.json())
		.then(data => {
			if (data.status === 'success' && data.csrf_token) {
				this.csrfToken = data.csrf_token;
			}
			return data;
		});
	},

	refreshJWT: function (url, refreshToken) {
		const headers = {
			'Accept': 'application/json',
			'Content-Type': 'application/json'
		};
		if (this.csrfToken) {
			headers['X-CSRF-TOKEN'] = this.csrfToken;
		}
		return fetch(url, {
			method: 'POST',
			credentials: 'include',
			headers: headers,
			referrerPolicy: 'no-referrer-when-downgrade',
			body: JSON.stringify({ refresh_token: refreshToken })
		}).then(response => response.json());
	},

	// Schedule the next token refresh, triggering a refresh shortly before the token expires
	scheduleTokenRefresh: function (expiresIn, refreshToken) {
		// Refresh 1 minute before expiration
		const refreshUrl = this.AppWSConn.ws_auth_refresh_url || this.AppWSConn.ws_auth_url;
		const expiresInSeconds = Number(expiresIn);
		if (!refreshUrl || typeof refreshToken !== 'string' || !refreshToken.length ||
			!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) {
			this.invalidateJWT();
			return;
		}

		const refreshDelay = Math.max(0, (expiresInSeconds - this.tokenRefreshLeadTime) * 1000);
		window.clearTimeout(this.tokenRefreshTimer);
		// Set the timer to trigger one minute before the token expires
		this.tokenRefreshTimer = setTimeout(() => {
			this.refreshJWT(refreshUrl, refreshToken)
				.then(data => {
					if (data.status === "success" && typeof data.access_token === 'string' && data.access_token.length) {
						const newJwt = data.access_token;
						const newRefreshToken = data.refresh_token;
						const newExpiresIn = data.expires_in;
						// Update token without reconnecting
						this.sendNewJWT(newJwt);
						// Schedule the next refresh using the new expiration time
						this.scheduleTokenRefresh(newExpiresIn, newRefreshToken);
					} else {
						this.invalidateJWT();
					}
				})
				.catch(error => {
					console.error("Error refreshing JWT:", error);
					this.invalidateJWT();
				});
		}, refreshDelay);
	},

	// Sends the new JWT to the server over the already-open WebSocket connection
	sendNewJWT: function (newJwt) {
		if (typeof newJwt !== 'string' || !newJwt.length) {
			this.invalidateJWT();
			return;
		}

		if (this.socket && this.socket.readyState === WebSocket.OPEN) {
			// Notify the server to update the JWT used for authentication
			this.socket.send(JSON.stringify({ action: "validate_token", token: newJwt }));
		}
		// Also update the locally stored token
		this.authInvalidated = false;
		this.currentJWT = newJwt;
	},

	// Clear unusable credentials and terminate their authenticated connection
	invalidateJWT: function () {
		window.clearTimeout(this.tokenRefreshTimer);
		this.tokenRefreshTimer = null;
		this.authInvalidated = true;
		this.currentJWT = null;
		this.csrfToken = null;

		if (this.socket && (this.socket.readyState === WebSocket.CONNECTING ||
			this.socket.readyState === WebSocket.OPEN))
			this.socket.close();
	},

	reconnect: function (wsConn) {
		if (this.retries >= this.maxRetries)
			return window.clearTimeout(this.wsTimer);

		this.retries++;
		// Exponential backoff
		if (this.currDelay < this.maxDelay)
			this.currDelay *= 2;
		this.setWebSocket(wsConn, this.currentJWT, null);
	},

	buildWSURI: function (wsConn) {
		var url = null;
		if (!wsConn.url || !wsConn.port)
			return null;
		url = /^wss?:\/\//i.test(wsConn.url) ? wsConn.url : window.location.protocol === "https:" ? 'wss://' + wsConn.url : 'ws://' + wsConn.url;
		return new URL(url).protocol + '//' + new URL(url).hostname + ':' + wsConn.port + new URL(url).pathname;
	},

	setWebSocket: function (wsConn, jwt, messageInterval) {
		var host = null, pingId = null, uri = null, defURI = null, str = null;
		// Store the JWT used for this connection
		this.authInvalidated = false;
		this.currentJWT = jwt;

		// If no external messageInterval is provided, set up local message rotation
		if (jwt && !messageInterval) {
			const messages = [
				'Validating WebSocket tokens... Please wait.',
				'Authenticating WebSocket connection... Please wait.',
				'Verifying WebSocket credentials... Please wait.',
				'Authorizing WebSocket session... Please wait.'
			];
			let currentMessageIndex = 0;
			messageInterval = setInterval(() => {
				if (currentMessageIndex < messages.length) {
					$('.app-loading-status > small').innerHTML = messages[currentMessageIndex];
					currentMessageIndex++;
				}
			}, 100);
		}

		defURI = window.location.hostname ? window.location.hostname + ':' + wsConn.port : "localhost" + ':' + wsConn.port;
		uri = wsConn.url && /^(wss?:\/\/)?[^\/]+:[0-9]{1,5}/.test(wsConn.url) ? wsConn.url : this.buildWSURI(wsConn);

		str = uri || defURI;
		str = !/^wss?:\/\//i.test(str) ? (window.location.protocol === "https:" ? 'wss://' : 'ws://') + str : str;

		if (jwt) {
			const separator = str.includes('?') ? '&' : '?';
			str = str + separator + 'token=' + encodeURIComponent(jwt);
		}
		// Store socket for token refresh
		var socket = new WebSocket(str);
		this.socket = socket;

		socket.onopen = function (event) {
			clearInterval(messageInterval);
			if (this.currentJWT)
				this.setStatusMessage('Authentication successful.');

			this.currDelay = this.wsDelay;
			this.retries = 0;

			if (wsConn.ping_interval) {
				pingId = setInterval(() => { socket.send('ping'); }, wsConn.ping_interval * 1E3);
			}
			GoAccess.Nav.WSOpen(str);

		}.bind(this);

		socket.onmessage = function (event) {
			this.AppState['updated'] = true;
			this.AppData = JSON.parse(event.data);
			if (!this.isAppInitialized) {
				GoAccess.App.initialize();
				GoAccess.Nav.WSOpen(str);
				this.isAppInitialized = true;
			}
			this.App.renderData();
		}.bind(this);

		socket.onclose = function (event) {
			clearInterval(messageInterval);
			this.setStatusMessage('Unable to authenticate WebSocket.');
			this.hideSpinner();

			GoAccess.Nav.WSClose();
			window.clearInterval(pingId);
			this.socket = null;
			if (!this.authInvalidated)
				this.wsTimer = setTimeout(() => { this.reconnect(wsConn); }, this.currDelay);
		}.bind(this);
	},
};

// HELPERS
GoAccess.Util = {
	months: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul","Aug", "Sep", "Oct", "Nov", "Dec"],

	// Escape a string for safe HTML interpolation
	escapeHTML: function (s) {
		return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
			return ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]);
		});
	},

	// Add all attributes of n to o
	merge: function (o, n) {
		var obj = {}, i = 0, il = arguments.length, key;
		for (; i < il; i++) {
			for (key in arguments[i]) {
				if (arguments[i].hasOwnProperty(key)) {
					obj[key] = arguments[i][key];
				}
			}
		}
		return obj;
	},

	// hash a string
	hashCode: function (s) {
		if (s == null) s = '';
		else if (typeof s !== 'string') s = JSON.stringify(s);
		return (s.split('').reduce(function (a, b) {
			a = ((a << 5) - a) + b.charCodeAt(0);
			return a & a;
		}, 0) >>> 0).toString(16);
	},

	// Format bytes to human-readable
	formatBytes: function (bytes, decimals, numOnly) {
		if (bytes == 0)
			return numOnly ? 0 : '0 Byte';
		var k = 1024;
		var dm = decimals + 1 || 2;
		var sizes = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
		var i = Math.floor(Math.log(bytes) / Math.log(k));
		return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + (numOnly ? '' : (' ' + sizes[i]));
	},

	// Validate number
	isNumeric: function (n) {
		return !isNaN(parseFloat(n)) && isFinite(n);
	},

	// Format microseconds to human-readable
	utime2str: function (usec) {
		if (usec >= 864E8)
			return ((usec) / 864E8).toFixed(2) + ' d';
		else if (usec >= 36E8)
			return ((usec) / 36E8).toFixed(2) + ' h';
		else if (usec >= 6E7)
			return ((usec) / 6E7).toFixed(2) + ' m';
		else if (usec >= 1E6)
			return ((usec) / 1E6).toFixed(2) + ' s';
		else if (usec >= 1E3)
			return ((usec) / 1E3).toFixed(2) + ' ms';
		return (usec).toFixed(2) + ' us';
	},

	// Format date from 20120124 to 24/Jan/2012
	formatDate: function (str) {
		var y = str.substr(0,4), m = str.substr(4,2) - 1, d = str.substr(6,2),
			h = str.substr(8,2) || 0, i = str.substr(10, 2)  || 0, s = str.substr(12, 2) || 0;
		var date = new Date(y,m,d,h,i,s);

		var out = ('0' + date.getDate()).slice(-2) + '/' + this.months[date.getMonth()] + '/' + date.getFullYear();
		10 <= str.length && (out += ":" + h);
		12 <= str.length && (out += ":" + i);
		14 <= str.length && (out += ":" + s);
		return out;
	},

	shortNum:  function (n) {
		if (n < 1e3) return n;
		if (n >= 1e3 && n < 1e6) return +(n / 1e3).toFixed(1) + "K";
		if (n >= 1e6 && n < 1e9) return +(n / 1e6).toFixed(1) + "M";
		if (n >= 1e9 && n < 1e12) return +(n / 1e9).toFixed(1) + "B";
		if (n >= 1e12) return +(n / 1e12).toFixed(1) + "T";
	},

	// Format field value to human-readable
	fmtValue: function (value, dataType, decimals, shorten, hlregex, hlvalue) {
		var val = 0;
		if (!dataType)
			val = value;

		switch (dataType) {
		case 'utime':
			val = this.utime2str(+value);
			break;
		case 'date':
			val = this.formatDate(value);
			break;
		case 'numeric':
			if (this.isNumeric(value))
				val = shorten ? this.shortNum(value) : (+value).toLocaleString();
			break;
		case 'bytes':
			val = this.formatBytes(value, decimals);
			break;
		case 'percent':
			val = value.replace(',', '.') + '%';
			break;
		case 'time':
			if (this.isNumeric(value))
				val = value.toLocaleString();
			break;
		case 'secs':
			var t = new Date(null);
			t.setSeconds(value);
			val = t.toISOString().substr(11, 8);
			break;
		default:
			val = value;
		}

		if (hlregex) {
			let o = JSON.parse(hlregex), tmp = '';
			for (var x in o) {
				if (!val) continue;
				tmp = val.replace(new RegExp(x, 'gi'), o[x]);
				if (tmp != val) {
					val = tmp;
					break;
				}
				val = tmp;
			}
		}

		return value == 0 ? String(val) : (val === undefined ? '-' : val);
	},

	isPanelHidden: function (panel) {
		return GoAccess.AppPrefs.hiddenPanels.includes(panel);
	},

	isPanelValid: function (panel) {
		var data = GoAccess.getPanelData(), ui = GoAccess.getPanelUI();
		return (!ui.hasOwnProperty(panel) || !data.hasOwnProperty(panel) || !ui[panel].id);
	},

	// Attempts to extract the count from either an object or a scalar.
	// e.g., item = Object {count: 14351, percent: 5.79} OR item = 4824825140
	getCount: function (item) {
		if (this.isObject(item) && 'count' in item)
			return item.count;
		return item;
	},

	getPercent: function (item) {
		if (this.isObject(item) && 'percent' in item)
			return this.fmtValue(item.percent, 'percent');
		return null;
	},

	isObject: function (o) {
		return o === Object(o);
	},

	setProp: function (o, s, v) {
		var schema = o;
		var a = s.split('.');
		for (var i = 0, n = a.length; i < n-1; ++i) {
			var k = a[i];
			if (!schema[k])
				schema[k] = {};
			schema = schema[k];
		}
		schema[a[n-1]] = v;
	},

	getProp: function (o, s) {
		s = s.replace(/\[(\w+)\]/g, '.$1');
		s = s.replace(/^\./, '');
		var a = s.split('.');
		for (var i = 0, n = a.length; i < n; ++i) {
			var k = a[i];
			if (this.isObject(o) && k in o) {
				o = o[k];
			} else {
				return;
			}
		}
		return o;
	},

	hasLocalStorage: function () {
		try {
			localStorage.setItem('test', 'test');
			localStorage.removeItem('test');
			return true;
		} catch(e) {
			return false;
		}
	},

	isWithinViewPort: function (el) {
		var elemTop = el.getBoundingClientRect().top;
		var elemBottom = el.getBoundingClientRect().bottom;
		return elemTop < window.innerHeight && elemBottom >= 0;
	},

	togglePanel: function(panel) {
		var index = GoAccess.AppPrefs.hiddenPanels.indexOf(panel);
		if (index == -1) {
			GoAccess.AppPrefs.hiddenPanels.push(panel);
		} else {
			GoAccess.AppPrefs.hiddenPanels.splice(index, 1);
		}
		GoAccess.setPrefs();

		delete GoAccess.AppCharts[panel];
		GoAccess.OverallStats.initialize();
		GoAccess.Panels.initialize();
		GoAccess.Charts.initialize();
		GoAccess.Tables.initialize();
	},

	reorderPanels: function(fromIndex, toIndex) {
		var order = GoAccess.AppPrefs.panelOrder;

		// Ensure we have a valid order array
		if (!order || order.length === 0) {
			console.error('Panel order not initialized');
			return;
		}

		// Validate indices
		if (fromIndex < 0 || fromIndex >= order.length ||
			toIndex < 0 || toIndex >= order.length) {
			console.error('Invalid drag indices', fromIndex, toIndex);
			return;
		}

		// Perform the reorder
		var item = order.splice(fromIndex, 1)[0];
		order.splice(toIndex, 0, item);

		// Save preferences
		GoAccess.setPrefs();

		// Re-render panels in new order
		GoAccess.Panels.initialize();
		GoAccess.Charts.initialize();
		GoAccess.Tables.initialize();
	},

	// Copy string to clipboard with fallback
	copyToClipboard: function (text, label) {
		if (!text) return;
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(text).then(function () {
				GoAccess.Toast.show('Copied to clipboard: ' + (label || text), 'success');
			}).catch(function () {
				GoAccess.Util.fallbackCopy(text, label);
			});
		} else {
			GoAccess.Util.fallbackCopy(text, label);
		}
	},

	fallbackCopy: function (text, label) {
		var textArea = document.createElement('textarea');
		textArea.value = text;
		textArea.style.position = 'fixed';
		textArea.style.left = '-999999px';
		textArea.style.top = '-999999px';
		document.body.appendChild(textArea);
		textArea.focus();
		textArea.select();
		try {
			document.execCommand('copy');
			GoAccess.Toast.show('Copied to clipboard: ' + (label || text), 'success');
		} catch (err) {
			GoAccess.Toast.show('Failed to copy', 'error');
		}
		document.body.removeChild(textArea);
	}
};

// TOAST NOTIFICATIONS
GoAccess.Toast = {
	show: function (message, type, duration) {
		duration = duration || 2500;
		type = type || 'info';
		var container = $('#toast-container');
		if (!container) {
			container = document.createElement('div');
			container.id = 'toast-container';
			container.className = 'toast-container';
			document.body.appendChild(container);
		}
		var toast = document.createElement('div');
		toast.className = 'toast toast-' + type;
		var icon = type === 'success' ? 'fa-check-circle' : 'fa-info-circle';
		toast.innerHTML = '<i class="fa ' + icon + ' toast-icon" aria-hidden="true"></i><span class="toast-msg">' + message + '</span>';
		container.appendChild(toast);

		requestAnimationFrame(function () {
			toast.classList.add('toast-show');
		});

		setTimeout(function () {
			toast.classList.remove('toast-show');
			setTimeout(function () {
				if (toast.parentNode) toast.parentNode.removeChild(toast);
			}, 300);
		}, duration);
	}
};

// KEY INSIGHTS (frontend-only summary over existing window.json_data).
// No new log fields or C aggregation: reads general + requests +
// status_codes/not_found + browsers + vhosts/visit_time. Every insight
// degrades to null when its source panel/field is absent.
GoAccess.Insights = {
	maxRows: 8,

	num: function (v) {
		var n = GoAccess.Util.getCount(v);
		return GoAccess.Util.isNumeric(n) ? +n : 0;
	},

	topBy: function (rows, fn, n) {
		rows = (rows || []).slice();
		rows.sort(function (a, b) { return fn(b) - fn(a); });
		return rows.slice(0, n || 1);
	},

	sumHits: function (rows) {
		var t = 0;
		(rows || []).forEach(function (r) { t += GoAccess.Insights.num(r.hits); });
		return t;
	},

	esc: function (s) {
		return GoAccess.Util.escapeHTML(s);
	},

	fmtURL: function (url, max) {
		url = String(url == null ? '' : url);
		if (!url.trim()) url = '(root / empty)';
		max = max || 60;
		var short = url.length > max ? url.slice(0, max - 1) + '…' : url;
		return this.esc(short);
	},

	slowest: function () {
		var rows = GoAccess.getPanelData('requests');
		rows = rows && rows.data ? rows.data : [];
		rows = rows.filter(function (r) { return GoAccess.Insights.num(r.avgts) > 0; });
		var top = this.topBy(rows, function (r) { return GoAccess.Insights.num(r.avgts); }, 1)[0];
		if (!top) return null;
		return {
			label: 'Slowest endpoint (avg)',
			value: this.fmtURL(top.data) + ' · ' + GoAccess.Util.fmtValue(this.num(top.avgts), 'utime'),
			sub: this.num(top.hits).toLocaleString() + ' hits · max ' + GoAccess.Util.fmtValue(this.num(top.maxts), 'utime'),
			tone: this.num(top.avgts) >= 1E6 ? 'warn' : '',
		};
	},

	latencyHealth: function () {
		var rows = GoAccess.getPanelData('requests');
		rows = rows && rows.data ? rows.data : [];
		var timed = rows.filter(function (r) { return GoAccess.Insights.num(r.avgts) > 0; });
		if (!timed.length) return null;
		var total = 0, sat = 0, tol = 0, frust = 0;
		timed.forEach(function (r) {
			var h = GoAccess.Insights.num(r.hits);
			var avg = GoAccess.Insights.num(r.avgts);
			total += h;
			if (avg <= 100000) {
				sat += h;
			} else if (avg <= 500000) {
				tol += h;
			} else {
				frust += h;
			}
		});
		if (!total) return null;
		var apdex = (sat + tol * 0.5) / total;
		var satPct = (100 * sat / total).toFixed(1);
		var tolPct = (100 * tol / total).toFixed(1);
		var frustPct = (100 * frust / total).toFixed(1);
		var rating = apdex >= 0.94 ? 'Excellent' : (apdex >= 0.85 ? 'Good' : (apdex >= 0.70 ? 'Fair' : 'Poor'));
		var tone = apdex >= 0.94 ? 'ok' : (apdex >= 0.85 ? '' : (apdex >= 0.70 ? 'warn' : 'danger'));
		return {
			label: 'Latency Health (Apdex)',
			value: apdex.toFixed(2) + ' · ' + rating + ' (' + satPct + '% < 100ms)',
			sub: '100–500ms: ' + tolPct + '% · >500ms: ' + frustPct + '%',
			tone: tone,
		};
	},

	bandwidthHog: function () {
		var rows = GoAccess.getPanelData('requests');
		rows = rows && rows.data ? rows.data : [];
		rows = rows.filter(function (r) { return GoAccess.Insights.num(r.bytes) > 0; });
		var top = this.topBy(rows, function (r) { return GoAccess.Insights.num(r.bytes); }, 1)[0];
		if (!top) return null;
		var pct = GoAccess.Util.getPercent(top.bytes);
		return {
			label: 'Top bandwidth URL',
			value: this.fmtURL(top.data) + ' · ' + GoAccess.Util.fmtValue(this.num(top.bytes), 'bytes'),
			sub: pct ? pct + ' of served bytes' : this.num(top.hits).toLocaleString() + ' hits',
			tone: '',
		};
	},

	errors: function (general) {
		var rows = GoAccess.getPanelData('status_codes');
		rows = rows && rows.data ? rows.data : [];
		var serverErr = 0, total = 0;
		rows.forEach(function (r) {
			var h = GoAccess.Insights.num(r.hits);
			total += h;
			if (/^5xx/.test(String(r.data))) serverErr += h;
		});
		if (!total) return null;
		var share = total ? (100 * serverErr / total) : 0;
		var nf = GoAccess.getPanelData('not_found');
		nf = nf && nf.data ? nf.data : [];
		var top404 = this.topBy(nf, function (r) { return GoAccess.Insights.num(r.hits); }, 1)[0];
		return {
			label: 'Server errors (5xx share)',
			value: share.toFixed(2) + '% of classified hits (' + serverErr.toLocaleString() + ')',
			sub: top404 ? 'Top 404: ' + this.fmtURL(top404.data) + ' (' + this.num(top404.hits).toLocaleString() + ' hits)' : null,
			tone: share >= 5 ? 'danger' : (share >= 1 ? 'warn' : 'ok'),
		};
	},

	bots: function () {
		var rows = GoAccess.getPanelData('browsers');
		rows = rows && rows.data ? rows.data : [];
		var total = this.sumHits(rows);
		if (!total) return null;
		var aiHits = 0, searchHits = 0, topAI = null;
		rows.forEach(function (r) {
			var name = String(r.data);
			if (/AI Crawler/i.test(name)) {
				aiHits += this.num(r.hits);
				var items = r.items || [];
				if (items.length) {
					var topItem = this.topBy(items, function (it) { return GoAccess.Insights.num(it.hits); }, 1)[0];
					if (topItem) topAI = topItem;
				}
			} else if (/Crawler/i.test(name)) {
				searchHits += this.num(r.hits);
			}
		}, this);
		var botHits = aiHits + searchHits;
		if (!botHits) return null;
		var totalShare = (100 * botHits / total).toFixed(1);
		var aiShare = (100 * aiHits / total).toFixed(1);
		var searchShare = (100 * searchHits / total).toFixed(1);
		var subParts = [];
		if (topAI) subParts.push('Top AI: ' + this.esc(String(topAI.data)));
		subParts.push('Search bots: ' + searchShare + '%');
		return {
			label: 'AI & Search Bot Share',
			value: 'AI: ' + aiShare + '% · Search: ' + searchShare + '% (' + botHits.toLocaleString() + ' hits)',
			sub: subParts.join(' · '),
			tone: (botHits / total) >= 0.3 ? 'warn' : '',
		};
	},

	scannerRadar: function () {
		var nf = GoAccess.getPanelData('not_found');
		nf = nf && nf.data ? nf.data : [];
		if (!nf.length) return null;
		var totalHits = this.sumHits(nf);
		if (!totalHits) return null;
		var probePattern = new RegExp('(\\.env|\\.git|\\.aws|\\.ssh|\\.yaml|\\.yml|\\.bak|\\.old|\\.swp|\\.save|\\.ini|\\.conf|\\.json|\\.sql|\\.tar|\\.zip|\\.tgz|\\.rar|\\.gz|\\.7z|wp-admin|wp-content|wp-includes|wordpress|wp-login|xmlrpc|phpmyadmin|pma|setup-config|info\\.php|phpinfo|eval|shell|cgi-bin|actuator|remote/fgt_lang|\\.php[0-9]?|\\.aspx?|\\.jsp)', 'i');
		var probeHits = 0, probeRows = [];
		nf.forEach(function (r) {
			var url = String(r.data || '');
			if (probePattern.test(url)) {
				var h = GoAccess.Insights.num(r.hits);
				probeHits += h;
				probeRows.push(r);
			}
		});
		if (!probeHits) return null;
		var probePct = (100 * probeHits / totalHits).toFixed(1);
		var topProbe = this.topBy(probeRows, function (r) { return GoAccess.Insights.num(r.hits); }, 1)[0];
		return {
			label: 'Threat Radar (Vulnerability Probes)',
			value: probePct + '% of top 404s (' + probeHits.toLocaleString() + ' probe hits)',
			sub: topProbe ? 'Top probe: ' + this.fmtURL(topProbe.data) + ' (' + this.num(topProbe.hits).toLocaleString() + ' hits)' : null,
			tone: probePct >= 50 ? 'danger' : (probePct >= 20 ? 'warn' : ''),
		};
	},

	vhostConcentration: function () {
		var rows = GoAccess.getPanelData('vhosts');
		rows = rows && rows.data ? rows.data : [];
		rows = rows.filter(function (r) { return String(r.data) !== 'UNKNOWN'; });
		if (!rows.length) return null;
		var topHits = this.topBy(rows, function (r) { return GoAccess.Insights.num(r.hits); }, 1)[0];
		var topBytes = this.topBy(rows, function (r) { return GoAccess.Insights.num(r.bytes); }, 1)[0];
		if (!topHits) return null;
		var pctHits = GoAccess.Util.getPercent(topHits.hits);
		var subText = this.num(topHits.hits).toLocaleString() + ' hits';
		var tone = '';
		if (topBytes && String(topBytes.data) !== String(topHits.data)) {
			var pctBw = GoAccess.Util.getPercent(topBytes.bytes);
			var bwFormatted = GoAccess.Util.fmtValue(this.num(topBytes.bytes), 'bytes');
			subText = 'Top bandwidth: ' + this.esc(String(topBytes.data)) + ' (' + (pctBw ? pctBw + ' · ' : '') + bwFormatted + ')';
			var bwRatio = GoAccess.Util.getCount(topBytes.bytes);
			if (bwRatio && GoAccess.Util.isNumeric(bwRatio.percent) && +bwRatio.percent >= 75) {
				tone = 'warn';
			}
		}
		return {
			label: 'Top Virtual Host',
			value: this.esc(String(topHits.data)) + (pctHits ? ' · ' + pctHits : ''),
			sub: subText,
			tone: tone,
		};
	},

	peakHour: function () {
		var rows = GoAccess.getPanelData('visit_time');
		rows = rows && rows.data ? rows.data : [];
		var top = this.topBy(rows, function (r) { return GoAccess.Insights.num(r.hits); }, 1)[0];
		if (!top) return null;
		var pct = GoAccess.Util.getPercent(top.hits);
		return {
			label: 'Peak Hour',
			value: this.esc(String(top.data)) + ':00 · ' + this.num(top.hits).toLocaleString() + ' hits' + (pct ? ' (' + pct + ')' : ''),
			sub: null,
			tone: '',
		};
	},

	build: function (general) {
		var out = [];
		var self = this;
		var fns = [
			function () { return self.slowest(); },
			function () { return self.latencyHealth(); },
			function () { return self.bandwidthHog(); },
			function () { return self.errors(general); },
			function () { return self.bots(); },
			function () { return self.scannerRadar(); },
			function () { return self.vhostConcentration(); },
			function () { return self.peakHour(); }
		];
		fns.forEach(function (fn) {
			try {
				var item = fn();
				if (item) out.push(item);
			} catch (e) {
			}
		});
		return out.slice(0, this.maxRows);
	},

	// Log-format coverage: which optional fields actually produced data.
	// Shown as a muted banner so legacy logs explain degraded insights.
	// Percentages are hits-weighted estimates from aggregated panels
	// (panels may be top-N truncated), not exact per-line counts.
	coverage: function () {
		var general = GoAccess.getPanelData('general') || {};
		var total = this.num(general.valid_requests) || this.num(general.total_requests) || 0;
		var parts = [];
		var vhosts = GoAccess.getPanelData('vhosts');
		vhosts = vhosts && vhosts.data ? vhosts.data : [];
		var unknownHits = 0, vhostHits = 0;
		vhosts.forEach(function (r) {
			var h = GoAccess.Insights.num(r.hits);
			vhostHits += h;
			if (String(r.data) === 'UNKNOWN') unknownHits += h;
		});
		var vhostPct = vhostHits > 0 ? Math.round(100 * (vhostHits - unknownHits) / vhostHits) : null;
		parts.push({key: 'vhost (%v)', ok: vhostPct != null && vhostPct > 0, pct: vhostPct});
		var req = GoAccess.getPanelData('requests');
		req = req && req.data ? req.data : [];
		var timedHits = 0, byteHits = 0, reqHits = 0;
		req.forEach(function (r) {
			var h = GoAccess.Insights.num(r.hits);
			reqHits += h;
			if (GoAccess.Insights.num(r.avgts) > 0 || GoAccess.Insights.num(r.cumts) > 0) timedHits += h;
			if (GoAccess.Insights.num(r.bytes) > 0) byteHits += h;
		});
		parts.push({key: 'timing (%T)', ok: timedHits > 0, pct: reqHits > 0 ? Math.round(100 * timedHits / reqHits) : null});
		parts.push({key: 'bytes (%b)', ok: byteHits > 0, pct: reqHits > 0 ? Math.round(100 * byteHits / reqHits) : null});
		var br = GoAccess.getPanelData('browsers');
		br = br && br.data ? br.data : [];
		var brTotal = this.sumHits(br), brUnknown = 0;
		br.forEach(function (r) {
			if (String(r.data) === 'Unknown' || String(r.data) === 'Others') brUnknown += this.num(r.hits);
		}, this);
		parts.push({key: 'agent (%u)', ok: brTotal > 0 && (brTotal - brUnknown) > 0, pct: brTotal > 0 ? Math.round(100 * (brTotal - brUnknown) / brTotal) : null});
		if (total) parts.total = total;
		return parts;
	},
};

// OVERALL STATS
GoAccess.OverallStats = {
	total_requests: 0,

	getStatIcon: function (key) {
		var map = {
			'total_requests': 'server',
			'valid_requests': 'check-circle-o',
			'failed_requests': 'times-circle-o',
			'generation_time': 'clock-o',
			'unique_visitors': 'users',
			'unique_files': 'file-text-o',
			'excluded_hits': 'ban',
			'unique_referrers': 'external-link',
			'unique_not_found': 'exclamation-triangle',
			'unique_static_files': 'file-code-o',
			'log_size': 'hdd-o',
			'bandwidth': 'exchange'
		};
		return map[key] || 'bar-chart';
	},

	// Render each overall stats box
	renderBox: function (data, ui, row, x, idx) {
		var wrap = $('#overall ul');
		var box = document.createElement('li');
		var value = GoAccess.Util.fmtValue(data[x], ui.items[x].dataType);

		if (ui.items[x].secondaryKey && data.hasOwnProperty(ui.items[x].secondaryKey))
			value += ' / ' + GoAccess.Util.fmtValue(data[ui.items[x].secondaryKey], ui.items[x].dataType);

		// we need to append the element first, otherwise outerHTML won't work
		wrap.appendChild(box);

		box.outerHTML = GoAccess.AppTpls.General.items.render({
			'id': x,
			'className': ui.items[x].className,
			'label': ui.items[x].label,
			'value': value,
			'icon': this.getStatIcon(x)
		});

		return wrap;
	},

	// Render overall stats
	renderData: function (data, ui) {
		var idx = 0, row = null;

		$('.last-updated').innerHTML = data.date_time;
		$('#overall').innerHTML = '';

		if (GoAccess.Util.isPanelHidden('general'))
			return false;

		$('#overall').innerHTML = GoAccess.AppTpls.General.wrap.render(GoAccess.Util.merge(ui, {
			'from': data.start_date,
			'to': data.end_date,
			'meta': this.renderMeta(data),
			'insights': GoAccess.Insights.build(data),
			'coverage': this.renderCoverage(),
		}));
		$('#overall').setAttribute('aria-labelledby', 'overall-heading');

		// Iterate over general data object
		for (var x in data) {
			if (!data.hasOwnProperty(x) || !ui.items.hasOwnProperty(x))
				continue;
			row = this.renderBox(data, ui, row, x, idx);
			idx++;
		}
	},

	// One-line provenance: generated at, log source, log size.
	renderMeta: function (data) {
		var bits = [];
		if (data.date_time) bits.push('Generated ' + GoAccess.Util.escapeHTML(String(data.date_time)));
		if (data.log_path && data.log_path.length)
			bits.push('Source: ' + GoAccess.Util.escapeHTML([].concat(data.log_path).join(', ')));
		if (data.log_size != null) bits.push('Log size: ' + GoAccess.Util.fmtValue(data.log_size, 'bytes'));
		if (data.generation_time != null) bits.push('Parsed in ' + GoAccess.Util.fmtValue(data.generation_time, 'secs'));
		return bits.join(' &middot; ');
	},

	// Coverage banner: which optional log fields produced data.
	renderCoverage: function () {
		var parts = GoAccess.Insights.coverage();
		var fmt = function (p) {
			var label = GoAccess.Util.escapeHTML(p.key);
			if (p.pct != null) label += ' ~' + p.pct + '% of hits';
			return (p.ok ? '✓ ' : '✗ ') + label;
		};
		var missing = parts.filter(function (p) { return !p.ok; });
		var summary = parts.map(fmt).join(' &middot; ');
		if (!missing.length) return 'Log coverage (est.): ' + summary + '.';
		return 'Log coverage (est.): ' + summary + ' &mdash; related insights hidden, rows preserved.';
	},

	// Render general/overall analyzed requests.
	initialize: function () {
		var ui = GoAccess.getPanelUI('general');
		var data = GoAccess.getPanelData('general');
		this.total_requests = data.total_requests;

		this.renderData(data, ui);
	}
};

// RENDER PANELS
GoAccess.Nav = {
	currentDrawer: null,

	open: function (type, e) {
		if (e) e.stopPropagation();
		if ($('nav').classList.contains('active') && this.currentDrawer === type) {
			this.close();
			return;
		}
		this.currentDrawer = type;
		if (type === 'opts') {
			this.renderOptsContent();
		} else {
			this.renderMenuContent();
		}
		$('nav').classList.add('active');
		document.body.classList.add('has-nav-open');
	},

	close: function () {
		$('nav').classList.remove('active');
		document.body.classList.remove('has-nav-open');
		this.currentDrawer = null;
	},

	events: function () {
		$('.nav-bars').onclick = function (e) {
			e.stopPropagation();
			this.open('menu', e);
		}.bind(this);

		$('.nav-gears').onclick = function (e) {
			e.stopPropagation();
			this.open('opts', e);
		}.bind(this);

		if ($('.nav-minibars')) {
			$('.nav-minibars').onclick = function (e) {
				e.stopPropagation();
				this.open('opts', e);
			}.bind(this);
		}

		// Close button inside sidebar
		$$('.nav-close-btn, .nav-close', function (btn) {
			btn.onclick = function (e) {
				e.stopPropagation();
				this.close();
			}.bind(this);
		}.bind(this));

		// Prevent clicks inside sidebar from closing it prematurely
		$('nav').onclick = function (e) {
			e.stopPropagation();
		};

		// Document click outside sidebar closes it
		document.onclick = function (e) {
			if ($('nav').classList.contains('active') && !e.target.closest('nav') && !e.target.closest('.nav-bars') && !e.target.closest('.nav-gears')) {
				this.close();
			}
		}.bind(this);

		// Escape key closes sidebar
		window.addEventListener('keydown', function (e) {
			if (e.key === 'Escape' && $('nav').classList.contains('active')) {
				this.close();
			}
		}.bind(this));

		$$('.export-json', function (item) {
			item.onclick = function (e) {
				this.downloadJSON(e);
			}.bind(this);
		}.bind(this));

		$$('.theme-bright', function (item) {
			item.onclick = function (e) {
				this.setTheme('bright');
			}.bind(this);
		}.bind(this));

		$$('.theme-dark-blue', function (item) {
			item.onclick = function (e) {
				this.setTheme('darkBlue');
			}.bind(this);
		}.bind(this));

		$$('.theme-dark-gray', function (item) {
			item.onclick = function (e) {
				this.setTheme('darkGray');
			}.bind(this);
		}.bind(this));

		$$('.theme-dark-purple', function (item) {
			item.onclick = function (e) {
				this.setTheme('darkPurple');
			}.bind(this);
		}.bind(this));

		$$('a.layout-horizontal', function (item) {
			item.onclick = function (e) {
				this.setLayout('horizontal');
			}.bind(this);
		}.bind(this));

		$$('a.layout-vertical', function (item) {
			item.onclick = function (e) {
				this.setLayout('vertical');
			}.bind(this);
		}.bind(this));

		$$('a.layout-wide', function (item) {
			item.onclick = function (e) {
				this.setLayout('wide');
			}.bind(this);
		}.bind(this));

		$$('[data-perpage]', function (item) {
			item.onclick = function (e) {
				this.setPerPage(e);
			}.bind(this);
		}.bind(this));

		$$('[data-show-tables]', function (item) {
			item.onclick = function (e) {
				this.toggleTables();
			}.bind(this);
		}.bind(this));

		$$('[data-autohide-tables]', function (item) {
			item.onclick = function (e) {
				this.toggleAutoHideTables();
			}.bind(this);
		}.bind(this));

		$$('.toggle-panel', function (item) {
			item.onclick = function (e) {
				e.stopPropagation();
				var panel = e.currentTarget.getAttribute('data-panel');
				GoAccess.Util.togglePanel(panel);
				item.classList.toggle('active');
			}.bind(this);
		}.bind(this));

		$$('.drag-handle', function (item) {
			var li = item.closest('li');

			// Don't make the overall stats draggable
			var link = li.querySelector('a');
			if (link && link.getAttribute('href') === '#') {
				return; // Skip overall stats item
			}

			li.setAttribute('draggable', 'true');

			li.ondragstart = function(e) {
				e.dataTransfer.effectAllowed = 'move';
				e.dataTransfer.setData('text/html', this.innerHTML);
				this.classList.add('dragging');

				// Get the actual panel key from the link
				var panelLink = this.querySelector('a');
				var panelKey = panelLink ? panelLink.getAttribute('href').substring(1) : '';
				e.dataTransfer.setData('panelKey', panelKey);

				// Store the index in the ordered list (excluding overall)
				var allItems = Array.from(this.parentNode.children);
				var draggableItems = allItems.filter(function(item) {
					var itemLink = item.querySelector('a');
					return itemLink && itemLink.getAttribute('href') !== '#';
				});
				var fromIndex = draggableItems.indexOf(this);
				e.dataTransfer.setData('index', fromIndex);
			};

			li.ondragend = function(e) {
				this.classList.remove('dragging');
				$$('.nav-list li', function(item) {
					item.classList.remove('drag-over');
				});
			};

			li.ondragover = function(e) {
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';

				// Only allow drop on other draggable items
				var link = this.querySelector('a');
				if (link && link.getAttribute('href') !== '#') {
					return false;
				}
				return true;
			};

			li.ondragenter = function(e) {
				e.preventDefault();
				// Only highlight if it's a valid drop target
				var link = this.querySelector('a');
				if (link && link.getAttribute('href') !== '#') {
					this.classList.add('drag-over');
				}
			};

			li.ondragleave = function(e) {
				// Check if we're actually leaving the element (not just entering a child)
				if (e.target === this) {
					this.classList.remove('drag-over');
				}
			};

			li.ondrop = function(e) {
				e.stopPropagation();
				e.preventDefault();

				// Don't allow dropping on overall stats
				var targetLink = this.querySelector('a');
				if (targetLink && targetLink.getAttribute('href') === '#') {
					return false;
				}

				var fromIndex = parseInt(e.dataTransfer.getData('index'));

				// Calculate toIndex from draggable items only
				var allItems = Array.from(this.parentNode.children);
				var draggableItems = allItems.filter(function(item) {
					var itemLink = item.querySelector('a');
					return itemLink && itemLink.getAttribute('href') !== '#';
				});
				var toIndex = draggableItems.indexOf(this);

				if (fromIndex !== toIndex && fromIndex !== -1 && toIndex !== -1) {
					GoAccess.Util.reorderPanels(fromIndex, toIndex);
					// Re-render the menu to show new order
					GoAccess.Nav.renderMenu();
				}

				this.classList.remove('drag-over');
				return false;
			};
		}.bind(this));
	},

	downloadJSON: function (e) {
		var targ = e.currentTarget;
		var data = "text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(GoAccess.getPanelData()));
		targ.href = 'data:' + data;
		targ.download = 'goaccess-' + (+new Date()) + '.json';
	},

	refreshOptsIfOpen: function () {
		if ($('nav')?.classList.contains('active') && this.currentDrawer === 'opts') {
			this.renderOptsContent();
		}
	},

	setLayout: function (layout) {
		document.body.classList.remove('layout-horizontal', 'layout-wide', 'layout-vertical');
		document.body.classList.add('layout-' + layout);

		GoAccess.AppPrefs['layout'] = layout;
		GoAccess.setPrefs();

		GoAccess.Panels.initialize();
		GoAccess.Charts.initialize();
		GoAccess.Tables.initialize();

		this.refreshOptsIfOpen();
	},

	toggleAutoHideTables: function (e) {
		var autoHideTables = GoAccess.Tables.autoHideTables();
		$$('.table-wrapper', function (item) {
			if (autoHideTables) {
				item.classList.remove('hidden-xs');
			} else {
				item.classList.add('hidden-xs');
			}
		}.bind(this));

		GoAccess.AppPrefs['autoHideTables'] = !autoHideTables;
		GoAccess.setPrefs();

		this.refreshOptsIfOpen();
	},

	toggleTables: function () {
		var ui = GoAccess.getPanelUI();
		var showTables = GoAccess.Tables.showTables();
		Object.keys(ui).forEach(function (panel, idx) {
			if (!GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel))
				ui[panel]['table'] = !showTables;
		}.bind(this));

		GoAccess.AppPrefs['showTables'] = !showTables;
		GoAccess.setPrefs();

		GoAccess.Panels.initialize();
		GoAccess.Charts.initialize();
		GoAccess.Tables.initialize();

		this.refreshOptsIfOpen();
	},

	setTheme: function (theme) {
		if (!theme)
			return;

		$('html').className = '';
		switch(theme) {
		case 'darkGray':
			document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#09090b');
			$('html').classList.add('dark');
			$('html').classList.add('gray');
			break;
		case 'darkBlue':
			document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0b1120');
			$('html').classList.add('dark');
			$('html').classList.add('blue');
			break;
		case 'darkPurple':
			document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0f0b1e');
			$('html').classList.add('dark');
			$('html').classList.add('purple');
			break;
		default:
			document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#f8fafc');
			$('html').classList.add('bright');
			break;
		}
		GoAccess.AppPrefs['theme'] = theme;
		GoAccess.setPrefs();

		this.refreshOptsIfOpen();
	},

	getIcon: function (key) {
		switch(key) {
		case 'visitors'        : return 'users';
		case 'requests'        : return 'file';
		case 'static_requests' : return 'file-text';
		case 'not_found'       : return 'file-o';
		case 'hosts'           : return 'user';
		case 'os'              : return 'desktop';
		case 'browsers'        : return 'chrome';
		case 'visit_time'      : return 'clock-o';
		case 'vhosts'          : return 'th-list';
		case 'referrers'       : return 'external-link';
		case 'referring_sites' : return 'external-link';
		case 'status_codes'    : return 'warning';
		case 'remote_user'     : return 'users';
		case 'geolocation'     : return 'map-marker';
		case 'asn'             : return 'map-marker';
		case 'mime_type'       : return 'file-o';
		case 'tls_type'        : return 'warning';
		case 'utm_campaigns'   : return 'tags';
		default                : return 'pie-chart';
		}
	},

	getItems: function () {
		var ui = GoAccess.getPanelUI(), menu = [], panels = [];

		// Collect all valid panels
		for (var panel in ui) {
			if (GoAccess.Util.isPanelValid(panel))
				continue;
			panels.push({
				'current': window.location.hash.substr(1) == panel,
				'head': ui[panel].head,
				'key': panel,
				'icon': this.getIcon(panel),
				'hidden': GoAccess.Util.isPanelHidden(panel)
			});
		}

		// Initialize panel order if empty
		if (!GoAccess.AppPrefs.panelOrder || GoAccess.AppPrefs.panelOrder.length === 0) {
			GoAccess.AppPrefs.panelOrder = panels.map(function(p) { return p.key; });
			GoAccess.setPrefs();
		}

		// Sort panels according to saved order
		var orderedPanels = [];
		var order = GoAccess.AppPrefs.panelOrder;

		// First add panels in the saved order
		for (var i = 0; i < order.length; i++) {
			var panel = panels.find(function(p) { return p.key === order[i]; });
			if (panel) orderedPanels.push(panel);
		}

		// Then add any new panels that aren't in the saved order
		for (var j = 0; j < panels.length; j++) {
			if (!order.includes(panels[j].key)) {
				orderedPanels.push(panels[j]);
				GoAccess.AppPrefs.panelOrder.push(panels[j].key);
			}
		}

		return orderedPanels;
	},

	setPerPage: function (e) {
		GoAccess.AppPrefs['perPage'] = +e.currentTarget.getAttribute('data-perpage');
		GoAccess.App.renderData();
		GoAccess.setPrefs();

		GoAccess.Tables.initialize();
		this.refreshOptsIfOpen();
	},

	getTheme: function () {
		return GoAccess.AppPrefs.theme || 'darkGray';
	},

	getLayout: function () {
		return GoAccess.AppPrefs.layout || 'horizontal';
	},

	getPerPage: function () {
		return GoAccess.AppPrefs.perPage || 7;
	},

	// Render left-hand side navigation options.
	renderOptsContent: function () {
		var navList = $('.nav-list');
		if (!navList) return;

		var o = {};
		o[this.getLayout()] = true;
		o[this.getTheme()] = true;
		o['perPage' + this.getPerPage()] = true;
		o['autoHideTables'] = GoAccess.Tables.autoHideTables();
		o['showTables'] = GoAccess.Tables.showTables();
		o['labels'] = GoAccess.i18n;

		navList.innerHTML = GoAccess.AppTpls.Nav.opts.render(o);
		this.events();
	},

	renderOpts: function (e) {
		this.open('opts', e);
	},

	// Render left-hand side navigation given the available panels.
	renderMenuContent: function () {
		var navList = $('.nav-list');
		if (!navList) return;

		navList.innerHTML = GoAccess.AppTpls.Nav.menu.render({
			'nav': this.getItems(),
			'overall_current': window.location.hash.substr(1) == '',
			'overall_hidden': GoAccess.Util.isPanelHidden('general'),
			'labels': GoAccess.i18n,
		});
		this.events();
	},

	renderMenu: function (e) {
		this.open('menu', e);
	},

	WSStatus: function () {
		if (Object.keys(GoAccess.AppWSConn).length)
			$$('.nav-ws-status', function (item) { item.style.display = 'block'; });
	},

	WSClose: function () {
		$$('.nav-ws-status', function (item) {
			item.classList.remove('fa-circle');
			item.classList.add('fa-stop');
			item.setAttribute('aria-label', GoAccess.i18n.websocket_disconnected);
			item.setAttribute('title', GoAccess.i18n.websocket_disconnected);
		});
	},

	WSOpen: function (str) {
		const baseUrl = str.split('?')[0].split('#')[0];
		$$('.nav-ws-status', function (item) {
			item.classList.remove('fa-stop');
			item.classList.add('fa-circle');
			item.setAttribute('aria-label', `${GoAccess.i18n.websocket_connected} (${baseUrl})`);
			item.setAttribute('title', `${GoAccess.i18n.websocket_connected} (${baseUrl})`);
		});
	},

	// Render left-hand side navigation given the available panels.
	renderWrap: function (nav) {
		$('nav').innerHTML = GoAccess.AppTpls.Nav.wrap.render(GoAccess.i18n);
	},

	// Iterate over all available panels and render each.
	initialize: function () {
		this.renderWrap();
		this.setTheme(GoAccess.AppPrefs.theme);
		this.WSStatus();
		this.events();
	}
};

// RENDER PANELS
GoAccess.Panels = {
	events: function () {
		$$('[data-toggle=dropdown]', function (item) {
			item.onclick = function (e) {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				// Keyboard-triggered clicks (Enter/Space) report detail === 0:
				// move focus into the menu so it is operable without a mouse.
				var viaKeyboard = e && e.detail === 0;
				this.toggleOpts(e.currentTarget, viaKeyboard);
			}.bind(this);
			item.onblur = null;
			item.onkeydown = function (e) {
				var key = e.key;
				if (key === 'ArrowDown' || key === 'Down') {
					if (e.preventDefault) e.preventDefault();
					if (e.stopPropagation) e.stopPropagation();
					this.openOpts(e.currentTarget, true);
				} else if (key === 'ArrowUp' || key === 'Up') {
					if (e.preventDefault) e.preventDefault();
					if (e.stopPropagation) e.stopPropagation();
					this.openOpts(e.currentTarget, 'last');
				}
			}.bind(this);
		}.bind(this));
		this.bindGlobalOptsCloser();
		this.bindOptsMenuKeys();

		$$('.panel-focus-btn', function (item) {
			item.onclick = function (e) {
				e.stopPropagation();
				var p = e.currentTarget.getAttribute('data-panel');
				this.toggleFocus(p);
			}.bind(this);
		}.bind(this));

		$$('[data-plot]', function (item) {
			item.onclick = function (e) {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				GoAccess.Charts.redrawChart(e.currentTarget);
			}.bind(this);
		}.bind(this));

		$$('[data-chart]', function (item) {
			item.onclick = function (e) {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				GoAccess.Charts.toggleChart(e.currentTarget);
			}.bind(this);
		}.bind(this));

		$$('[data-chart-type]', function (item) {
			item.onclick = function (e) {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				GoAccess.Charts.setChartType(e.currentTarget);
			}.bind(this);
		}.bind(this));

		$$('[data-metric]', function (item) {
			item.onclick = function (e) {
				if (e && e.preventDefault) e.preventDefault();
				if (e && e.stopPropagation) e.stopPropagation();
				GoAccess.Tables.toggleColumn(e.currentTarget);
			}.bind(this);
		}.bind(this));

		$$('.panel-export-csv', function (item) {
			item.onclick = function (e) {
				if (e && e.preventDefault) e.preventDefault();
				e.stopPropagation();
				var panel = e.currentTarget.getAttribute('data-panel');
				GoAccess.Tables.downloadCSV(panel);
			};
		});

		$$('.panel-export-json', function (item) {
			item.onclick = function (e) {
				if (e && e.preventDefault) e.preventDefault();
				e.stopPropagation();
				var panel = e.currentTarget.getAttribute('data-panel');
				GoAccess.Tables.downloadPanelJSON(panel);
			};
		});
	},

	toggleFocus: function (panel) {
		var box = $('#panel-' + panel);
		if (!box) return;
		var article = box.closest('article');
		if (!article) return;

		var isFocused = article.classList.contains('panel-focused');

		// Clear any existing focus
		$$('article.panel-focused', function (el) {
			el.classList.remove('panel-focused');
			var icon = el.querySelector('.panel-focus-btn i');
			if (icon) {
				icon.classList.remove('fa-compress');
				icon.classList.add('fa-arrows-alt');
			}
		});
		document.body.classList.remove('has-panel-focused');

		if (!isFocused) {
			article.classList.add('panel-focused');
			document.body.classList.add('has-panel-focused');
			var icon = article.querySelector('.panel-focus-btn i');
			if (icon) {
				icon.classList.remove('fa-arrows-alt');
				icon.classList.add('fa-compress');
			}
			GoAccess.Toast.show('Entered focus mode (Esc to exit)', 'info', 1800);
		}

		if (GoAccess.AppCharts[panel]) {
			setTimeout(function () {
				GoAccess.Charts.reloadChart(GoAccess.AppCharts[panel], panel);
			}, 50);
		}
	},

	openOpts: function (targ, focusMenu) {
		if (!targ || !targ.parentElement) return;
		var panel = targ.getAttribute('data-panel');
		targ.setAttribute('aria-expanded', 'true');
		targ.parentElement.classList.add('open');
		this.renderOpts(panel);
		if (focusMenu) this.focusMenuItem(panel, focusMenu === 'last' ? 'last' : 'first');
	},

	closeOpts: function (targ, refocus) {
		var btn = targ && targ.getAttribute ? targ : (targ && targ.currentTarget);
		if (!btn || !btn.parentElement) return;
		btn.parentElement.classList.remove('open');
		var expanded = btn.parentElement.querySelector('[aria-expanded]');
		if (expanded) expanded.setAttribute('aria-expanded', 'false');
		if (refocus && btn.focus) btn.focus();
	},

	closeAllOpts: function (except, refocus) {
		var self = this;
		$$('[data-toggle=dropdown]', function (item) {
			if (item !== except) self.closeOpts(item);
		});
		if (refocus && except && except.focus) except.focus();
	},

	toggleOpts: function (targ, focusMenu) {
		if (!targ || !targ.parentElement) return;
		var isOpen = targ.parentElement.classList.contains('open');
		this.closeAllOpts(targ);
		if (isOpen) {
			this.closeOpts(targ);
		} else {
			this.openOpts(targ, focusMenu);
		}
	},

	getMenuLinks: function (panel) {
		var menu = $('.panel-opts-' + panel);
		if (!menu) return [];
		return Array.prototype.filter.call(menu.querySelectorAll('a[href]'), function (a) {
			return a.offsetParent !== null || a.getClientRects().length > 0;
		});
	},

	focusMenuItem: function (panel, which) {
		var links = this.getMenuLinks(panel);
		if (!links.length) return;
		var el = which === 'last' ? links[links.length - 1] : links[0];
		if (el && el.focus) el.focus();
	},

	bindOptsMenuKeys: function () {
		var self = this;
		$$('.dropdown-menu[class*="panel-opts-"]', function (menu) {
			if (menu._optsKeysBound) return;
			menu._optsKeysBound = true;
			menu.onkeydown = function (e) {
				var link = e.target && e.target.closest ? e.target.closest('a[href]') : null;
				if (!link) return;
				var panel = link.getAttribute('data-panel');
				var links = self.getMenuLinks(panel);
				var idx = links.indexOf(link);
				if (e.key === 'ArrowDown' || e.key === 'Down') {
					if (e.preventDefault) e.preventDefault();
					if (e.stopPropagation) e.stopPropagation();
					var next = links[(idx + 1) % links.length];
					if (next && next.focus) next.focus();
				} else if (e.key === 'ArrowUp' || e.key === 'Up') {
					if (e.preventDefault) e.preventDefault();
					if (e.stopPropagation) e.stopPropagation();
					var prev = links[(idx - 1 + links.length) % links.length];
					if (prev && prev.focus) prev.focus();
				} else if (e.key === 'Home') {
					if (e.preventDefault) e.preventDefault();
					if (links[0] && links[0].focus) links[0].focus();
				} else if (e.key === 'End') {
					if (e.preventDefault) e.preventDefault();
					var last = links[links.length - 1];
					if (last && last.focus) last.focus();
				} else if (e.key === 'Tab') {
					// Let Tab move naturally out of the menu, then close it.
					var btn = document.querySelector('[data-toggle=dropdown][data-panel="' + panel + '"]');
					setTimeout(function () { self.closeOpts(btn); }, 0);
				}
			};
		});
	},

	bindGlobalOptsCloser: function () {
		if (this._optsCloserBound) return;
		this._optsCloserBound = true;
		var self = this;
		document.addEventListener('click', function (e) {
			if (e.target && e.target.closest && e.target.closest('.dropdown'))
				return;
			self.closeAllOpts(null);
		}, true);
		document.addEventListener('keydown', function (e) {
			if (e.key === 'Escape') {
				var open = document.querySelector('.dropdown.open [data-toggle=dropdown]');
				self.closeAllOpts(null);
				if (open && open.focus) open.focus();
			}
		}, true);
		document.addEventListener('focusin', function (e) {
			if (e.target && e.target.closest && e.target.closest('.dropdown'))
				return;
			self.closeAllOpts(null);
		}, true);
	},

	setPlotSelection: function (ui, prefs) {
		if (!ui.plot || !ui.plot.length) return;
		var chartType = ((prefs || {}).plot || {}).chartType || ui.plot[0].chartType;
		var metric = ((prefs || {}).plot || {}).metric || ui.plot[0].className;

		ui[chartType] = true;
		for (var i = 0, len = ui.plot.length; i < len; ++i)
			if (ui.plot[i].className == metric)
				ui.plot[i]['selected'] = true;
	},

	setColSelection: function (items, prefs) {
		var columns = (prefs || {}).columns || {};
		for (var i = 0, len = items.length; i < len; ++i)
			if ((items[i].key in columns) && columns[items[i].key]['hide'])
				items[i]['hide'] = true;
	},

	setChartSelection: function (ui, prefs) {
		ui['showChart'] = prefs && ('chart' in prefs) ? prefs.chart : true;
	},

	setOpts: function (panel) {
		var ui = JSON.parse(JSON.stringify(GoAccess.getPanelUI(panel))), prefs = GoAccess.getPrefs(panel);
		if (!ui.plot) ui.plot = [];
		if (!ui.items) ui.items = [];
		// set preferences selection upon opening panel options
		this.setChartSelection(ui, prefs);
		this.setPlotSelection(ui, prefs);
		this.setColSelection(ui.items, prefs);
		return GoAccess.Util.merge(ui, {'labels': GoAccess.i18n});
	},

	renderOpts: function (panel) {
		var menu = $('.panel-opts-' + panel);
		if (!menu) return;
		try {
			menu.innerHTML = GoAccess.AppTpls.Panels.opts.render(this.setOpts(panel));
		} catch (e) {
			if (window.console && console.error) console.error('renderOpts failed for panel ' + panel, e);
			return;
		}
		this.events();
	},

	enablePrev: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-prev');
		if ($pagination) {
			$pagination.parentNode.classList.remove('disabled');
			$pagination.setAttribute('aria-disabled', 'false');
		}
	},

	disablePrev: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-prev');
		if ($pagination) {
			$pagination.parentNode.classList.add('disabled');
			$pagination.setAttribute('aria-disabled', 'true');
		}
	},

	enableNext: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-next');
		if ($pagination) {
			$pagination.parentNode.classList.remove('disabled');
			$pagination.setAttribute('aria-disabled', 'false');
		}
	},

	disableNext: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-next');
		if ($pagination) {
			$pagination.parentNode.classList.add('disabled');
			$pagination.setAttribute('aria-disabled', 'true');
		}
	},

	enableFirst: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-first');
		if ($pagination) {
			$pagination.parentNode.classList.remove('disabled');
			$pagination.setAttribute('aria-disabled', 'false');
		}
	},

	disableFirst: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-first');
		if ($pagination) {
			$pagination.parentNode.classList.add('disabled');
			$pagination.setAttribute('aria-disabled', 'true');
		}
	},

	enableLast: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-last');
		if ($pagination) {
			$pagination.parentNode.classList.remove('disabled');
			$pagination.setAttribute('aria-disabled', 'false');
		}
	},

	disableLast: function (panel) {
		var $pagination = $('#panel-' + panel + ' .pagination a.panel-last');
		if ($pagination) {
			$pagination.parentNode.classList.add('disabled');
			$pagination.setAttribute('aria-disabled', 'true');
		}
	},

	enablePagination: function (panel) {
		this.enablePrev(panel);
		this.enableNext(panel);
		this.enableFirst(panel);
		this.enableLast(panel);
	},

	disablePagination: function (panel) {
		this.disablePrev(panel);
		this.disableNext(panel);
		this.disableFirst(panel);
		this.disableLast(panel);
	},

	hasSubItems: function (ui, data) {
		for (var i = 0, len = data.length; i < len; ++i) {
			if (!data[i].items)
				return (ui['hasSubItems'] = false);
			if (data[i].items.length) {
				return (ui['hasSubItems'] = true);
			}
		}
		return false;
	},

	setComputedData: function (panel, ui, data) {
		this.hasSubItems(ui, data.data);
		GoAccess.Charts.hasChart(panel, ui);
		GoAccess.Tables.hasTable(ui);
	},

	// Render the given panel given a user interface definition.
	renderPanel: function (panel, ui, col) {
		// set some computed values before rendering panel structure
		var data = GoAccess.getPanelData(panel);
		this.setComputedData(panel, ui, data);

		// per panel wrapper
		var box = document.createElement('div');
		box.id = 'panel-' + panel;
		box.innerHTML = GoAccess.AppTpls.Panels.wrap.render(GoAccess.Util.merge(ui, {
			'labels': GoAccess.i18n
		}));

		// add accessible label to parent article
		col.setAttribute('aria-labelledby', panel);

		col.appendChild(box);

		// Remove pagination if not enough data for the given panel
		if (data.data.length <= GoAccess.getPrefs().perPage)
			this.disablePagination(panel);
		GoAccess.Tables.renderThead(panel, ui);

		return col;
	},

	createCol: function (panel) {
		var isHero = (panel === 'visitors');
		var col = document.createElement('article');
		col.setAttribute('class', 'panel-col panel-' + panel + (isHero ? ' panel-hero' : ''));
		$('#panels').appendChild(col);

		return col;
	},

	resetPanel: function (panel) {
		var ui = GoAccess.getPanelUI();
		var ele = $('#panel-' + panel);

		if (GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel))
			return false;

		clearMapFullscreen(d3.select('#chart-' + panel));
		var col = ele.parentNode;
		col.removeChild(ele);
		// Render panel given a user interface definition
		this.renderPanel(panel, ui[panel], col);
		this.events();
	},

	// Iterate over all available panels and render each panel structure.
	renderPanels: function () {
		var ui = GoAccess.getPanelUI(), col = null;
		var order = GoAccess.AppPrefs.panelOrder || [];

		clearMapFullscreen(d3.select('.' + MAP_FULLSCREEN_CLASS));
		$('#panels').innerHTML = '';

		// If no order is set, create default order
		if (order.length === 0) {
			for (var panel in ui) {
				if (!GoAccess.Util.isPanelValid(panel) && !GoAccess.Util.isPanelHidden(panel)) {
					order.push(panel);
				}
			}
			GoAccess.AppPrefs.panelOrder = order;
			GoAccess.setPrefs();
		}

		// Render panels in the specified order
		for (var i = 0; i < order.length; i++) {
			var panel = order[i];
			if (GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel))
				continue;

			col = this.createCol(panel);
			this.renderPanel(panel, ui[panel], col);
		}

		// Render any new panels not in the order array
		for (var panel in ui) {
			if (GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel))
				continue;
			if (!order.includes(panel)) {
				col = this.createCol(panel);
				this.renderPanel(panel, ui[panel], col);
				order.push(panel);
			}
		}

		GoAccess.AppPrefs.panelOrder = order;
		GoAccess.setPrefs();
	},

	initialize: function () {
		this.renderPanels();
		this.events();
	}
};

// RENDER CHARTS
GoAccess.Charts = {
	iter: function (callback) {
		Object.keys(GoAccess.AppCharts).forEach(function (panel) {
			// redraw chart only if it's within the viewport
			if (!GoAccess.Util.isWithinViewPort($('#panel-' + panel)))
				return;
			if (callback && typeof callback === 'function')
				callback.call(this, GoAccess.AppCharts[panel], panel);
		});
	},

	getMetricKeys: function (panel, key) {
		return GoAccess.getPanelUI(panel)['items'].map(function (a) { return a[key]; });
	},

	getPanelData: function (panel, data) {
		// Grab ui plot data for the selected panel
		var plot = GoAccess.Util.getProp(GoAccess.AppState, panel + '.plot');

		// Grab the data for the selected panel, respecting expanded state
		if (!data) {
			var subItems = GoAccess.Tables.getSubItemsData(panel);
			data = this.processChartData(subItems.length ? subItems : GoAccess.getPanelData(panel).data);
		}
		return plot.chartReverse ? data.reverse() : data;
	},

	drawPlot: function (panel, plotUI, data) {
		var chart = this.getChart(panel, plotUI, data);
		if (!chart)
			return;

		this.renderChart(panel, chart, data);
		GoAccess.AppCharts[panel] = null;
		GoAccess.AppCharts[panel] = chart;
	},

	setChartType: function (targ) {
		var panel = targ.getAttribute('data-panel');
		var type = targ.getAttribute('data-chart-type');

		GoAccess.Util.setProp(GoAccess.AppPrefs, panel + '.plot.chartType', type);
		GoAccess.setPrefs();

		var plotUI = GoAccess.Util.getProp(GoAccess.AppState, panel + '.plot');
		// Extract data for the selected panel and process it
		this.drawPlot(panel, plotUI, this.getPanelData(panel));
	},

	toggleChart: function (targ) {
		var panel = targ.getAttribute('data-panel');
		var prefs = GoAccess.getPrefs(panel),
			chart = prefs && ('chart' in prefs) ? prefs.chart : true;

		GoAccess.Util.setProp(GoAccess.AppPrefs, panel + '.chart', !chart);
		GoAccess.setPrefs();

		GoAccess.Panels.resetPanel(panel);
		GoAccess.Charts.resetChart(panel);
		GoAccess.Tables.renderFullTable(panel);
	},

	hasChart: function (panel, ui) {
		var prefs = GoAccess.getPrefs(panel),
			chart = prefs && ('chart' in prefs) ? prefs.chart : true;
		ui['chart'] = ui.plot.length && chart && chart;
	},

	// Redraw a chart upon selecting a metric.
	redrawChart: function (targ) {
		var plot = targ.getAttribute('data-plot');
		var panel = targ.getAttribute('data-panel');
		var ui = GoAccess.getPanelUI(panel);
		var plotUI = ui.plot;

		GoAccess.Util.setProp(GoAccess.AppPrefs, panel + '.plot.metric', plot);
		GoAccess.setPrefs();

		// Iterate over plot user interface definition
		for (var x in plotUI) {
			if (!plotUI.hasOwnProperty(x) || plotUI[x].className != plot)
				continue;

			GoAccess.Util.setProp(GoAccess.AppState, panel + '.plot', plotUI[x]);
			// Extract data for the selected panel and process it
			this.drawPlot(panel, plotUI[x], this.getPanelData(panel));
			break;
		}
	},

	// Iterate over the item properties and extract the count value.
	extractCount: function (item) {
		var o = {};
		for (var prop in item)
			o[prop] = GoAccess.Util.getCount(item[prop]);
		return o;
	},

	// Extract an array of objects that D3 can consume to process the chart.
	// e.g., o = Object {hits: 37402, visitors: 6949, bytes:
	// 505881789, avgts: 118609, cumts: 4436224010...}
	processChartData: function (data) {
		var out = [];
		for (var i = 0; i < data.length; ++i)
			out.push(this.extractCount(data[i]));
		return out;
	},

	findUIItem: function (panel, key) {
		var items = GoAccess.getPanelUI(panel).items;
		for (var i = 0; i < items.length; ++i) {
			if (items[i].key == key)
				return items[i];
		}
		return null;
	},

	getXKey: function (datum, key) {
		var arr = [];
		if (typeof key === 'string')
			return datum[key];
		for (var prop in key)
			arr.push(datum[key[prop]]);
		return arr.join(' ');
	},

	getWMap: function (panel, plotUI, data, projectionType) {
		var chart = WorldMap(d3.select("#chart-" + panel));
		chart.width($("#chart-" + panel).getBoundingClientRect().width);
		chart.height(400);
		chart.metric(plotUI['d3']['y0']['key']);
		chart.opts(plotUI);
		chart.projectionType(projectionType == 'wmap' ? 'mercator' : 'orthographic');
		chart.panel(panel);

		return chart;
	},

	getAreaSpline: function (panel, plotUI, data) {
		var dualYaxis = plotUI['d3']['y1'];

		var chart = AreaChart(dualYaxis)
		.labels({
			y0: plotUI['d3']['y0'].label,
			y1: dualYaxis ? plotUI['d3']['y1'].label : ''
		})
		.x(function (d) {
			if ((((plotUI || {}).d3 || {}).x || {}).key)
				return this.getXKey(d, plotUI['d3']['x']['key']);
			return d.data;
		}.bind(this))
		.y0(function (d) {
			return +d[plotUI['d3']['y0']['key']];
		})
		.width($("#chart-" + panel).getBoundingClientRect().width)
		.height(175)
		.format({
			x: (this.findUIItem(panel, 'data') || {}).dataType || null,
			y0: ((plotUI.d3 || {}).y0 || {}).format,
			y1: ((plotUI.d3 || {}).y1 || {}).format,
		})
		.opts(plotUI);

		dualYaxis && chart.y1(function (d) {
			return +d[plotUI['d3']['y1']['key']];
		});

		return chart;
	},

	getVBar: function (panel, plotUI, data) {
		var dualYaxis = plotUI['d3']['y1'];

		var chart = BarChart(dualYaxis)
		.labels({
			y0: plotUI['d3']['y0'].label,
			y1: dualYaxis ? plotUI['d3']['y1'].label : ''
		})
		.x(function (d) {
			if ((((plotUI || {}).d3 || {}).x || {}).key)
				return this.getXKey(d, plotUI['d3']['x']['key']);
			return d.data;
		}.bind(this))
		.y0(function (d) {
			return +d[plotUI['d3']['y0']['key']];
		})
		.width($("#chart-" + panel).getBoundingClientRect().width)
		.height(175)
		.format({
			x: (this.findUIItem(panel, 'data') || {}).dataType || null,
			y0: ((plotUI.d3 || {}).y0 || {}).format,
			y1: ((plotUI.d3 || {}).y1 || {}).format,
		})
		.opts(plotUI);

		dualYaxis && chart.y1(function (d) {
			return +d[plotUI['d3']['y1']['key']];
		});

		return chart;
	},

	getChartType: function (panel) {
		var ui = GoAccess.getPanelUI(panel);
		if (!ui.chart)
			return '';

		return GoAccess.Util.getProp(GoAccess.getPrefs(), panel + '.plot.chartType') || ui.plot[0].chartType;
	},

	getPlotUI: function (panel, ui) {
		var metric = GoAccess.Util.getProp(GoAccess.getPrefs(), panel + '.plot.metric');
		if (!metric)
			return ui.plot[0];
		return ui.plot.filter(function (v) {
			return v.className == metric;
		})[0];
	},

	getChart: function (panel, plotUI, data) {
		var chart = null;

		// Render given its type
		switch (this.getChartType(panel)) {
		case 'area-spline':
			chart = this.getAreaSpline(panel, plotUI, data);
			break;
		case 'bar':
			chart = this.getVBar(panel, plotUI, data);
			break;
		case 'wmap':
		case 'gmap':
			chart = this.getWMap(panel, plotUI, data, this.getChartType(panel));
			break;
		}

		return chart;
	},

	renderChart: function (panel, chart, data) {
		var selection = d3.select('#chart-' + panel);

		if (!chart.isWorldMap)
			clearMapFullscreen(selection);
		// remove popup
		selection.select('.chart-tooltip-wrap')
			.remove();
		// remove svg
		selection.selectAll('svg')
			.remove();
		// add chart to the document
		selection
			.datum(data)
			.call(chart)
			.append("div").attr("class", "chart-tooltip-wrap");
	},

	addChart: function (panel, ui) {
		var plotUI = null, chart = null;

		// Ensure it has a plot definition
		if (!ui.plot || !ui.plot.length)
			return;

		plotUI = this.getPlotUI(panel, ui);
		// set ui plot data
		GoAccess.Util.setProp(GoAccess.AppState, panel + '.plot', plotUI);

		// Grab the data for the selected panel
		var data = this.getPanelData(panel);
		if (!(chart = this.getChart(panel, plotUI, data)))
			return;

		this.renderChart(panel, chart, data);
		GoAccess.AppCharts[panel] = chart;
	},

	// Render all charts for the applicable panels.
	renderCharts: function (ui) {
		for (var panel in ui) {
			if (GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel))
				continue;
			this.addChart(panel, ui[panel]);
		}
	},

	resetChart: function (panel) {
		var ui = {};
		if (GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel))
			return false;

		ui = GoAccess.getPanelUI(panel);
		this.addChart(panel, ui);
	},

	// Reload (doesn't redraw) the given chart's data
	reloadChart: function (chart, panel) {
		d3.select("#chart-" + panel)
			.datum(this.getPanelData(panel))
			.call(chart.width($("#chart-" + panel).offsetWidth))
			.append("div").attr("class", "chart-tooltip-wrap");
	},

	// Reload (doesn't redraw) all chart's data
	reloadCharts: function () {
		this.iter(function (chart, panel) {
			this.reloadChart(chart, panel);
		}.bind(this));
		GoAccess.AppState.updated = false;
	},

	// Only redraw charts with current data
	redrawCharts: function () {
		this.iter(function (chart, panel) {
			d3.select("#chart-" + panel).call(chart.width($("#chart-" + panel).offsetWidth));
		});
	},

	initialize: function () {
		this.renderCharts(GoAccess.getPanelUI());

		// reload on scroll & redraw on resize
		d3.select(window).on('scroll.charts', debounce(function () {
			this.reloadCharts();
		}, 250, false).bind(this)).on('resize.charts', function () {
			this.redrawCharts();
		}.bind(this));
	}
};

// RENDER TABLES
GoAccess.Tables = {
	chartData: {}, // holds all panel sub items data that feeds the chart

	getFilteredData: function (panel, dataItems) {
		if (!dataItems || !dataItems.length) return [];
		var query = (GoAccess.AppState[panel] && GoAccess.AppState[panel].searchQuery) ? GoAccess.AppState[panel].searchQuery.trim().toLowerCase() : '';
		if (!query) return dataItems;

		return dataItems.filter(function (item) {
			var str = String(item.data ?? '').toLowerCase();
			if (str.includes(query)) return true;
			if (item.items && item.items.length) {
				for (var i = 0; i < item.items.length; i++) {
					if (String(item.items[i].data ?? '').toLowerCase().includes(query)) return true;
				}
			}
			return false;
		});
	},

	onSearchInput: function (panel, query) {
		if (!GoAccess.AppState[panel]) GoAccess.AppState[panel] = {};
		GoAccess.AppState[panel].searchQuery = query;

		var fullData = (GoAccess.getPanelData(panel) || {}).data || [];
		var filtered = this.getFilteredData(panel, fullData);

		var $badge = $('.panel-search-badge[data-panel="' + panel + '"]');
		var $clear = $('.panel-search-clear[data-panel="' + panel + '"]');

		if (query && query.trim().length > 0) {
			if ($badge) {
				$badge.textContent = filtered.length + ' / ' + fullData.length;
				$badge.style.display = 'inline-block';
			}
			if ($clear) $clear.style.display = 'inline-block';
		} else {
			if ($badge) $badge.style.display = 'none';
			if ($clear) $clear.style.display = 'none';
		}

		this.renderTable(panel, 1);
	},

	events: function () {
		$$('.panel-next', function (item) {
			item.onclick = function (e) {
				var panel = e.currentTarget.getAttribute('data-panel');
				this.renderTable(panel, this.nextPage(panel));
			}.bind(this);
		}.bind(this));

		$$('.panel-prev', function (item) {
			item.onclick = function (e) {
				var panel = e.currentTarget.getAttribute('data-panel');
				this.renderTable(panel, this.prevPage(panel));
			}.bind(this);
		}.bind(this));

		$$('.panel-first', function (item) {
			item.onclick = function (e) {
				var panel = e.currentTarget.getAttribute('data-panel');
				this.renderTable(panel, "FIRST_PAGE");
			}.bind(this);
		}.bind(this));

		$$('.panel-last', function (item) {
			item.onclick = function (e) {
				var panel = e.currentTarget.getAttribute('data-panel');
				this.renderTable(panel, "LAST_PAGE");
			}.bind(this);
		}.bind(this));

		$$('.expandable>td', function (item) {
			item.onclick = function (e) {
				if (!window.getSelection().toString())
					this.toggleRow(e.currentTarget);
			}.bind(this);
		}.bind(this));

		$$('.row-expandable.clickable', function (item) {
			item.onclick = function (e) {
				this.toggleRow(e.currentTarget);
			}.bind(this);
		}.bind(this));

		$$('.sortable', function (item) {
			item.onclick = function (e) {
				this.sortColumn(e.currentTarget);
			}.bind(this);
			item.onkeydown = function (e) {
				if (e.key === 'Enter' || e.key === ' ') {
					if (e.preventDefault) e.preventDefault();
					this.sortColumn(e.currentTarget);
				}
			}.bind(this);
		}.bind(this));

		$$('.btn-copy', function (item) {
			item.onclick = function (e) {
				e.stopPropagation();
				var val = e.currentTarget.getAttribute('data-clipboard');
				GoAccess.Util.copyToClipboard(val);
			};
		});

		$$('.btn-lookup', function (item) {
			item.onclick = function (e) {
				e.stopPropagation();
			};
		});

		$$('.panel-search-input', function (item) {
			item.oninput = function (e) {
				var panel = e.currentTarget.getAttribute('data-panel');
				GoAccess.Tables.onSearchInput(panel, e.currentTarget.value);
			};
			item.onkeydown = function (e) {
				if (e.key === 'Escape') {
					e.currentTarget.value = '';
					var panel = e.currentTarget.getAttribute('data-panel');
					GoAccess.Tables.onSearchInput(panel, '');
					e.currentTarget.blur();
					e.preventDefault();
				}
			};
		});

		$$('.panel-search-clear', function (item) {
			item.onclick = function (e) {
				e.stopPropagation();
				var panel = e.currentTarget.getAttribute('data-panel');
				var input = $('.panel-search-input[data-panel="' + panel + '"]');
				if (input) input.value = '';
				GoAccess.Tables.onSearchInput(panel, '');
			};
		});
	},

	toggleColumn: function (targ) {
		var panel = targ.getAttribute('data-panel');
		var metric = targ.getAttribute('data-metric');

		var columns = (GoAccess.getPrefs(panel) || {}).columns || {};
		if (metric in columns) {
			delete columns[metric];
		} else {
			GoAccess.Util.setProp(columns, metric + '.hide', true);
		}

		GoAccess.Util.setProp(GoAccess.AppPrefs, panel + '.columns', columns);
		GoAccess.setPrefs();

		GoAccess.Tables.renderThead(panel, GoAccess.getPanelUI(panel));
		GoAccess.Tables.renderFullTable(panel);
	},

	sortColumn: function (ele) {
		var field = ele.getAttribute('data-key');
		var order = ele.getAttribute('data-order');
		var panel = ele.parentElement.parentElement.parentElement.getAttribute('data-panel');

		order = order ? 'asc' == order ? 'desc' : 'asc' : 'asc';
		GoAccess.App.sortData(panel, field, order);
		GoAccess.Util.setProp(GoAccess.AppState, panel + '.sort', {
			'field': field,
			'order': order,
		});
		this.renderThead(panel, GoAccess.getPanelUI(panel));
		this.renderTable(panel, this.getCurPage(panel));

		GoAccess.Charts.reloadChart(GoAccess.AppCharts[panel], panel);
	},

	getDataByKey: function (panel, key) {
		var data = GoAccess.getPanelData(panel).data;
		for (var i = 0, n = data.length; i < n; ++i) {
			if (GoAccess.Util.hashCode(data[i].data) == key)
				return data[i];
		}
		return null;
	},

	getSubItemsData: function (panel) {
		const expanded = GoAccess.Util.getProp(GoAccess.AppState, panel + '.expanded') || {};
		const fullData = (GoAccess.getPanelData(panel) || {}).data || [];
		let results = [];
		const appendVisible = function (items, parentPath) {
			items.forEach(function (item) {
				const itemKey = GoAccess.Util.hashCode(item.data);
				const itemPath = parentPath + '|' + itemKey;

				if (expanded[itemPath] && item.items) {
					appendVisible(item.items, itemPath);
				} else {
					results.push(item);
				}
			});
		};

		fullData.forEach(function (root) {
			const rootKey = GoAccess.Util.hashCode(root.data);
			if (expanded[rootKey] && root.items)
				appendVisible(root.items, rootKey);
		});

		return results;
	},

	addChartData: function (panel, keyPath) {
		if (!keyPath) return GoAccess.getPanelData(panel).data;

		const parts = keyPath.split('|');
		let current = GoAccess.getPanelData(panel).data;

		// Traverse the tree to the target node
		for (const part of parts) {
			const found = current.find(item => GoAccess.Util.hashCode(item.data) === part);
			if (!found || !found.items) return [];
			current = found.items;
		}

		// Store the current level's items under this exact path
		GoAccess.Util.setProp(this.chartData, panel + '.' + keyPath, current);

		// For the chart: we return **only the items at the current drill level**
		// (not all sub-items flattened - that was the old behavior)
		return current;
	},

	removeChartData: function (panel, keyPath) {
		// Remove this specific path
		const path = panel + '.' + keyPath;
		if (GoAccess.Util.getProp(this.chartData, path)) {
			// We don't have deleteProp -> set to null / empty
			GoAccess.Util.setProp(this.chartData, path, null);
		}

		// Find the deepest remaining expanded path (or fall back to top-level)
		const expanded = GoAccess.Util.getProp(GoAccess.AppState, panel + '.expanded') || {};
		let deepestPath = '';
		let maxDepth = -1;

		for (const k in expanded) {
			if (expanded[k] !== true) continue;
			const depth = k.split('|').length;
			if (depth > maxDepth) {
				maxDepth = depth;
				deepestPath = k;
			}
		}

		if (deepestPath) {
			return GoAccess.Util.getProp(this.chartData, panel + '.' + deepestPath) || GoAccess.getPanelData(panel).data;
		}
		return GoAccess.getPanelData(panel).data;
	},

	isExpanded: function (panel, key) {
		// getProp returns undefined if path doesn't exist -> treat as not expanded
		return !!GoAccess.Util.getProp(GoAccess.AppState, panel + '.expanded.' + key);
	},

	toggleExpanded: function (panel, key) {
		var path = panel + '.expanded.' + key;
		var currentlyExpanded = this.isExpanded(panel, key);

		if (currentlyExpanded) {
			// Instead of delete -> set to false or null
			GoAccess.Util.setProp(GoAccess.AppState, path, false);
			// or: GoAccess.Util.setProp(GoAccess.AppState, path, null);
			// or even remove the property completely if you prefer (see Option 2)
		} else {
			GoAccess.Util.setProp(GoAccess.AppState, path, true);
		}

		return currentlyExpanded; // returns true if it WAS expanded (now collapsed)
	},

	// Toggle children rows
	toggleRow: function (ele) {
		const row = ele.closest('tr');
		if (!row) return;

		const panel = row.getAttribute('data-panel');
		let key = row.getAttribute('data-node-key') || row.getAttribute('data-key');
		if (!key) return;

		const wasExpanded = this.toggleExpanded(panel, key);

		this.renderTable(panel, this.getCurPage(panel));

		const plotUI = GoAccess.AppCharts[panel]?.opts?.();
		if (!plotUI || !plotUI.redrawOnExpand) return;

		GoAccess.Charts.reloadChart(GoAccess.AppCharts[panel], panel);
	},

	// Get current panel page
	getCurPage: function (panel) {
		return GoAccess.Util.getProp(GoAccess.AppState, panel + '.curPage') || 0;
	},

	// Page offset.
	// e.g., Return Value: 11, curPage: 2
	pageOffSet: function (panel) {
		return ((this.getCurPage(panel) - 1) * GoAccess.getPrefs().perPage);
	},

	// Get total number of pages given the number of items on array
	getTotalPages: function (dataItems) {
		return Math.ceil(dataItems.length / GoAccess.getPrefs().perPage);
	},

	// Get a shallow copy of a portion of the given data array and the
	// current page.
	getPage: function (panel, dataItems, page) {
		var totalPages = this.getTotalPages(dataItems);
		if (page < 1)
			page = 1;
		if (page > totalPages)
			page = totalPages;

		GoAccess.Util.setProp(GoAccess.AppState, panel + '.curPage', page);
		var start = this.pageOffSet(panel);
		var end = start + GoAccess.getPrefs().perPage;

		return dataItems.slice(start, end);
	},

	// Get previous page
	prevPage: function (panel) {
		return this.getCurPage(panel) - 1;
	},

	// Get next page
	nextPage: function (panel) {
		return this.getCurPage(panel) + 1;
	},

	getMetaCell: function (ui, o, key) {
		var val =  o && (key in o) && o[key].value ? o[key].value : null;
		var perc = o &&  (key in o) && o[key].percent ? o[key].percent : null;

		// use metaType if exist else fallback to dataType
		var vtype = ui.metaType || ui.dataType;
		var className = ui.className || '';
		className += !['string'].includes(ui.dataType) ? 'text-right' : '';
		return {
			'className': className,
			'value'    : val ? GoAccess.Util.fmtValue(val, vtype) : null,
			'percent'  : perc,
			'title'    : ui.meta,
			'label'    : ui.metaLabel || null,
		};
	},

	hideColumn: function (panel, col) {
		var columns = (GoAccess.getPrefs(panel) || {}).columns || {};
		return ((col in columns) && columns[col]['hide']);
	},

	showTables: function () {
		return ('showTables' in GoAccess.getPrefs()) ? GoAccess.getPrefs().showTables : true;
	},

	autoHideTables: function () {
		return ('autoHideTables' in GoAccess.getPrefs()) ? GoAccess.getPrefs().autoHideTables : true;
	},

	hasTable: function (ui) {
		ui['table'] = this.showTables();
		ui['autoHideTables'] = this.autoHideTables();
	},

	getMetaRows: function (panel, ui, key) {
		var cells = [], uiItems = ui.items;
		var data = GoAccess.getPanelData(panel).metadata;

		for (var i = 0; i < uiItems.length; ++i) {
			var item = uiItems[i];
			if (this.hideColumn(panel, item.key))
				continue;
			cells.push(this.getMetaCell(item, data[item.key], key));
		}

		return [{
			'hasSubItems': ui.hasSubItems,
			'cells': cells,
			'key' : key.substring(0, 3),
		}];
	},

	renderMetaRow: function (panel, metarows, className) {
		// find the table to set
		var table = $('.table-' + panel + ' tr.' + className);
		if (!table)
			return;

		table.innerHTML = GoAccess.AppTpls.Tables.meta.render({
			row: metarows
		});
	},

	// Iterate over user interface definition properties
	iterUIItems: function (panel, uiItems, dataItems, callback) {
		var out = [];
		for (var i = 0; i < uiItems.length; ++i) {
			var uiItem = uiItems[i];
			if (this.hideColumn(panel, uiItem.key))
				continue;
			// Data for the current user interface property.
			// e.g., dataItem = Object {count: 13949, percent: 5.63}
			var dataItem = dataItems[uiItem.key];
			// Apply the callback and push return data to output array
			if (callback && typeof callback == 'function') {
				var ret = callback.call(this, panel, uiItem, dataItem, dataItems);
				if (ret) out.push(ret);
			}
		}
		return out;
	},

	// Return an object that can be consumed by the table template given a user
	// interface definition and a cell value object.
	// e.g., value = Object {count: 14351, percent: 5.79}
	getObjectCell: function (panel, ui, value, rowData) {
		var className = ui.className || '';
		className += !['string'].includes(ui.dataType) ? 'text-right' : '';

		var rawCount = GoAccess.Util.getCount(value);
		var formattedVal = GoAccess.Util.fmtValue(rawCount, ui.dataType, null, null, ui.hlregex, ui.hlvalue, ui.hlidx);
		var percentStr = GoAccess.Util.getPercent(value);
		var percentNum = parseFloat(percentStr) || 0;

		var isNumericMetric = ['hits', 'visitors', 'bytes'].includes(ui.key);
		var rawVal = (rowData && rowData.data !== undefined) ? String(rowData.data) : (typeof value === 'string' ? value : '');

		var isDataCol = (ui.key === 'data');
		var isHost = (panel === 'hosts' && isDataCol);
		var isStatusCode = (panel === 'status_codes' && isDataCol);
		var canCopy = (isDataCol || ui.dataType === 'string') && rawVal.length > 0;

		var query = GoAccess.AppState[panel]?.searchQuery;
		if (query && query.trim().length > 0 && isDataCol && typeof rawVal === 'string') {
			var escapedQuery = query.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			formattedVal = formattedVal.replace(new RegExp('(' + escapedQuery + ')', 'gi'), '<mark class="search-match">$1</mark>');
		}

		return {
			'className': className,
			'percent': percentStr,
			'value': formattedVal,
			'showBar': isNumericMetric && percentNum > 0,
			'barPercent': Math.min(100, Math.max(0, percentNum)),
			'metricKey': ui.key,
			'rawCopyValue': canCopy ? rawVal : null,
			'isHost': isHost,
			'isStatusCode': isStatusCode
		};
	},

	// Given a data item object, set all the row cells and return a
	// table row that the template can consume.
	renderRow: function (panel, callback, ui, dataItem, idx, subItem, parentId, expanded, level) {
		var shade = ((!subItem && idx % 2 !== 0) ? 'shaded' : '') ||
					(subItem && (parentId % 2 !== 0) ? 'shaded' : '');
		var hasChildren = !!(dataItem.items && dataItem.items.length > 0);
		return {
			'panel'       : panel,
			'idx'         : !subItem ? String((idx + 1) + this.pageOffSet(panel)) : '',
			'key'         : !subItem ? GoAccess.Util.hashCode(String(dataItem.data ?? '')) : '',
			'nodeKey'     : GoAccess.Util.hashCode(String(dataItem.data ?? '')),
			'level'       : level || 0,
			'expanded'    : !!expanded,               // must be boolean
			'parentId'    : subItem ? String(parentId) : '',
			'className'   : (subItem ? 'child' : 'parent') + shade,
			'hasSubItems' : hasChildren,              // true if has children
			'items'       : hasChildren ? dataItem.items.length : 0,
			'cells'       : callback.call(this),
		};
	},

	renderRows: function(rows, panel, ui, dataItems, subItem, parentId, level = 0, parentPath = '') {
		subItem = subItem || false;
		level = level || 0; /* no data rows */
		if (dataItems.length === 0 && ui.items.length) {
			var query = (GoAccess.AppState[panel] && GoAccess.AppState[panel].searchQuery) ? GoAccess.AppState[panel].searchQuery : '';
			var emptyMsg = query ? 'No results matching "' + query + '".' : 'No data on this panel.';
			rows.push({
				cells: [{
					className: 'text-center',
					colspan: ui.items.length + 1,
					value: emptyMsg
				}]
			});
			return;
		}
		for (var i = 0; i < dataItems.length; ++i) {
			var dataItem = dataItems[i];
			var data = dataItem.data ?? dataItem;
			var isString = typeof dataItem === 'string';
			var cellcb;
			if (isString) {
				cellcb = function() {
					return [{
						'colspan': ui.items.length,
						'value': data,
						'showBar': false,
						'rawCopyValue': data
					}];
				};
			} else {
				cellcb = this.iterUIItems.bind(this, panel, ui.items, dataItem, this.getObjectCell.bind(this));
			}
			/* Unique key for this node (important for nested expansion state) */
			var itemKey = !isString ? GoAccess.Util.hashCode(String(dataItem.data ?? '')) : null;
			var nodeKey = itemKey && parentPath ? parentPath + '|' + itemKey : itemKey;
			var expanded = nodeKey && this.isExpanded(panel, nodeKey); /* Build row with indentation level */
			var row = this.renderRow(panel, cellcb, ui, dataItem, i, subItem, parentId, expanded); /* Add level for CSS indentation */
			row.level = level;
			row.nodeKey = nodeKey; /* for future use in events */
			row.isLeaf = !(dataItem.items && dataItem.items.length > 0);
			row.showPlaceholder = ui.hasSubItems && !row.hasSubItems;
			rows.push(row); /* Recurse into children if expanded */
			if (!isString && dataItem.items && dataItem.items.length && expanded) {
				this.renderRows(rows, panel, ui, dataItem.items, true, i, level + 1, nodeKey);
			}
		}
	},

	// Entry point to render all data rows into the table
	renderDataRows: function (panel, ui, dataItems, page) {
		// find the table to set
		var table = $('.table-' + panel + ' tbody.tbody-data');
		if (!table)
			return;

		dataItems = this.getPage(panel, dataItems, page);
		var rows = [];
		this.renderRows(rows, panel, ui, dataItems);
		if (rows.length == 0) {
			table.innerHTML = '<tr class="table-empty-row"><td colspan="20" class="text-center text-muted" style="padding: 28px 12px;"><i class="fa fa-search" style="margin-right: 6px; opacity: 0.5;" aria-hidden="true"></i>No data on this panel.</td></tr>';
			return;
		}

		table.innerHTML = GoAccess.AppTpls.Tables.data.render({
			rows: rows
		});
	},

	togglePagination: function (panel, page, dataItems) {
		GoAccess.Panels.enablePagination(panel);
		var total = this.getTotalPages(dataItems);
		this.renderPaginationStatus(panel, page, dataItems, total);
		if (total <= 1) {
			GoAccess.Panels.disablePagination(panel);
			return;
		}
		// Disable pagination next button if last page is reached
		if (page >= total) {
			GoAccess.Panels.disableNext(panel);
			GoAccess.Panels.disableLast(panel);
		}
		if (page <= 1) {
			GoAccess.Panels.disablePrev(panel);
			GoAccess.Panels.disableFirst(panel);
		}
	},

	renderPaginationStatus: function (panel, page, dataItems, total) {
		var el = document.querySelector('.pagination-status[data-panel="' + panel + '"]');
		if (!el) return;
		var perPage = GoAccess.getPrefs().perPage || 7;
		var count = (dataItems || []).length;
		page = Math.max(1, Math.min(page || 1, total || 1));
		if (!count || !total || total <= 1) {
			el.textContent = '';
			return;
		}
		var start = (page - 1) * perPage + 1;
		var end = Math.min(page * perPage, count);
		el.textContent = 'Showing ' + start + '–' + end + ' of ' + count;
	},

	renderTable: function (panel, page) {
		var fullData = (GoAccess.getPanelData(panel) || {}).data || [];
		var dataItems = this.getFilteredData(panel, fullData);
		var ui = GoAccess.getPanelUI(panel);

		var totalPages = this.getTotalPages(dataItems);
		if (page === "LAST_PAGE") {
			page = totalPages;
		} else if (page === "FIRST_PAGE" || !page || page < 1) {
			page = 1;
		} else if (page > totalPages && totalPages > 0) {
			page = totalPages;
		}

		this.togglePagination(panel, page, dataItems);
		// Render data rows
		this.renderDataRows(panel, ui, dataItems, page);
		this.events();
	},

	renderFullTable: function (panel) {
		var ui = GoAccess.getPanelUI(panel), page = 0;
		// panel's data
		var data = GoAccess.getPanelData(panel);

		// render meta data
		if (data.hasOwnProperty('metadata')) {
			this.renderMetaRow(panel, this.getMetaRows(panel, ui, 'min'), 'thead-min');
			this.renderMetaRow(panel, this.getMetaRows(panel, ui, 'max'), 'thead-max');
			this.renderMetaRow(panel, this.getMetaRows(panel, ui, 'avg'), 'thead-avg');
		}

		// render actual data
		if (data.hasOwnProperty('data')) {
			var filteredData = this.getFilteredData(panel, data.data);
			page = this.getCurPage(panel);
			this.togglePagination(panel, page, filteredData);
			this.renderDataRows(panel, ui, filteredData, page);
		}

		// render meta data
		if (data.hasOwnProperty('metadata')) {
			this.renderMetaRow(panel, this.getMetaRows(panel, ui, 'total'), 'tfoot-totals');
		}
	},

	// Iterate over all panels and determine which ones should contain
	// a data table.
	renderTables: function (force) {
		var ui = GoAccess.getPanelUI();
		for (var panel in ui) {
			if (GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel) || !this.showTables())
				continue;
			if (force || GoAccess.Util.isWithinViewPort($('#panel-' + panel)))
				this.renderFullTable(panel);
		}
	},

	// Given a UI panel definition, make a copy of it and assign the sort
	// fields to the template object to render
	sort2Tpl: function (panel, ui) {
		var uiClone = JSON.parse(JSON.stringify(ui)), out = [];
		var sort = GoAccess.Util.getProp(GoAccess.AppState, panel + '.sort');

		for (var i = 0, len = uiClone.items.length; i < len; ++i) {
			var item = uiClone.items[i];
			if (this.hideColumn(panel, item.key))
				continue;

			item['sort'] = false;
			if (item.key == sort.field && sort.order) {
				item['sort'] = true;
				item[sort.order.toLowerCase()] = true;
			}
			out.push(item);
		}
		uiClone.items = out;

		return uiClone;
	},

	renderThead: function (panel, ui) {
		var $thead = $('.table-' + panel + '>thead>tr.thead-cols'),
			$colgroup = $('.table-' + panel + '>colgroup');

		if ($thead && $colgroup && this.showTables()) {
			ui = this.sort2Tpl(panel, ui);

			$thead.innerHTML = GoAccess.AppTpls.Tables.head.render(ui);
			$colgroup.innerHTML = GoAccess.AppTpls.Tables.colgroup.render(ui);
		}
	},

	downloadCSV: function (panel) {
		var fullData = (GoAccess.getPanelData(panel) || {}).data || [];
		var ui = GoAccess.getPanelUI(panel);
		if (!fullData.length || !ui) return;

		var headers = [];
		var keys = [];
		ui.items.forEach(function(it) {
			if (!it.hide) {
				headers.push('"' + it.label.replace(/"/g, '""') + '"');
				keys.push(it.key);
			}
		});

		var csvRows = [headers.join(',')];
		fullData.forEach(function(row) {
			var line = [];
			keys.forEach(function(k) {
				var val = row[k];
				if (typeof val === 'object' && val !== null) val = val.count;
				if (val === undefined || val === null) val = '';
				line.push('"' + String(val).replace(/"/g, '""') + '"');
			});
			csvRows.push(line.join(','));
		});

		var blob = new Blob([csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = 'goaccess-' + panel + '-' + (+new Date()) + '.csv';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		GoAccess.Toast.show('Exported CSV for ' + ui.head, 'success', 2000);
	},

	downloadPanelJSON: function (panel) {
		var data = GoAccess.getPanelData(panel);
		var ui = GoAccess.getPanelUI(panel);
		if (!data) return;

		var jsonStr = JSON.stringify(data, null, 2);
		var blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8;' });
		var url = URL.createObjectURL(blob);
		var a = document.createElement('a');
		a.href = url;
		a.download = 'goaccess-' + panel + '-' + (+new Date()) + '.json';
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		GoAccess.Toast.show('Exported JSON for ' + (ui ? ui.head : panel), 'success', 2000);
	},

	reloadTables: function () {
		this.renderTables(false);
		this.events();
	},

	initialize: function () {
		this.renderTables(true);
		this.events();

		// redraw on scroll
		d3.select(window).on('scroll.tables', debounce(function () {
			this.reloadTables();
		}, 250, false).bind(this));
	},
};

// Main App
GoAccess.App = {
	hasFocus: true,

	tpl: function (tpl) {
		return Hogan.compile(tpl);
	},

	setTpls: function () {
		GoAccess.AppTpls = {
			'Nav': {
				'wrap': this.tpl($('#tpl-nav-wrap').innerHTML),
				'menu': this.tpl($('#tpl-nav-menu').innerHTML),
				'opts': this.tpl($('#tpl-nav-opts').innerHTML),
			},
			'Panels': {
				'wrap': this.tpl($('#tpl-panel').innerHTML),
				'opts': this.tpl($('#tpl-panel-opts').innerHTML),
			},
			'General': {
				'wrap': this.tpl($('#tpl-general').innerHTML),
				'items': this.tpl($('#tpl-general-items').innerHTML),
			},
			'Tables': {
				'colgroup': this.tpl($('#tpl-table-colgroup').innerHTML),
				'head': this.tpl($('#tpl-table-thead').innerHTML),
				'meta': this.tpl($('#tpl-table-row-meta').innerHTML),
				'totals': this.tpl($('#tpl-table-row-totals').innerHTML),
				'data': this.tpl($('#tpl-table-row').innerHTML),
			},
		};
	},

	sortField: function (o, field) {
	   var f = o[field];
	   if (GoAccess.Util.isObject(f) && (f !== null))
		   f = o[field].count;
		return f;
	},

	sortData: function (panel, field, order) {
		// panel's data
		var panelData = GoAccess.getPanelData(panel).data;

		// Function to sort an array of objects
		var sortArray = function(arr) {
			arr.sort(function (a, b) {
				a = this.sortField(a, field);
				b = this.sortField(b, field);

				if (typeof a === 'string' && typeof b === 'string')
					return 'asc' == order ? a.localeCompare(b) : b.localeCompare(a);
				return  'asc' == order ? a - b : b - a;
			}.bind(this));
		}.bind(this);

		// Sort panelData
		sortArray(panelData);

		// Sort the items sub-array
		panelData.forEach(function(item) {
			if (item.items) {
				sortArray(item.items);
			}
		});
	},

	setInitSort: function () {
		var ui = GoAccess.getPanelUI();
		for (var panel in ui) {
			if (GoAccess.Util.isPanelValid(panel))
				continue;
			GoAccess.Util.setProp(GoAccess.AppState, panel + '.sort', ui[panel].sort);
		}
	},

	// Verify if we need to sort panels upon data re-entry
	verifySort: function () {
		var ui = GoAccess.getPanelUI();
		for (var panel in ui) {
			if (GoAccess.Util.isPanelValid(panel) || GoAccess.Util.isPanelHidden(panel))
				continue;
			var sort = GoAccess.Util.getProp(GoAccess.AppState, panel + '.sort');
			// Panels introduced by later data updates have no initial sort state
			if (!sort) {
				GoAccess.Util.setProp(GoAccess.AppState, panel + '.sort', ui[panel].sort);
				continue;
			}
			// do not sort panels if they still hold the same sort properties
			if (JSON.stringify(sort) === JSON.stringify(ui[panel].sort))
				continue;
			this.sortData(panel, sort.field, sort.order);
		}
	},

	initDom: function () {
		var nav = $('nav');
		nav && nav.classList.remove('hide');
		var container = $('.container') || $('.container-fluid');
		container && container.classList.remove('hide');
		var spinner = $('.spinner');
		spinner && spinner.classList.add('hide');
		var loading = $('.app-loading-status > small');
		loading && (loading.style.display = 'none');

		var layout = GoAccess.AppPrefs['layout'] || 'horizontal';
		document.body.classList.remove('layout-horizontal', 'layout-wide', 'layout-vertical');
		document.body.classList.add('layout-' + layout);
	},

	renderData: function () {
		// update data and charts if tab/document has focus
		if (!this.hasFocus)
			return;

		// some panels may not have been properly rendered since no data was
		// passed when bootstrapping the report, thus we do a one full
		// re-render of all panels
		if (GoAccess.OverallStats.total_requests == 0 && GoAccess.OverallStats.total_requests != GoAccess.AppData.general.total_requests)
			GoAccess.Panels.initialize();
		GoAccess.OverallStats.total_requests = GoAccess.AppData.general.total_requests;

		this.verifySort();
		GoAccess.OverallStats.initialize();

		// do not rerender tables/charts if data hasn't changed
		if (!GoAccess.AppState.updated)
			return;

		GoAccess.Charts.reloadCharts();
		GoAccess.Tables.reloadTables();
	},

	renderPanels: function () {
		GoAccess.Nav.initialize();
		GoAccess.OverallStats.initialize();
		GoAccess.Panels.initialize();
		GoAccess.Charts.initialize();
		GoAccess.Tables.initialize();
	},

	initialize: function () {
		this.setInitSort();
		this.setTpls();
		this.initDom();
		this.renderPanels();
		GoAccess.Shortcuts.initialize();
	},
};

// KEYBOARD SHORTCUTS
GoAccess.Shortcuts = {
	initialize: function () {
		document.addEventListener('keydown', function (e) {
			var target = e.target;
			var isInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);

			if (e.key === 'Escape') {
				// If search input focused, blur and clear
				if (isInput && target.classList.contains('panel-search-input')) {
					var p = target.getAttribute('data-panel');
					if (target.value) {
						target.value = '';
						GoAccess.Tables.onSearchInput(p, '');
					}
					target.blur();
					e.preventDefault();
					return;
				}
				// Close focus mode if open
				if (document.body.classList.contains('has-panel-focused')) {
					$$('article.panel-focused', function (el) {
						var panel = el.querySelector('[data-panel]')?.getAttribute('data-panel');
						if (panel) GoAccess.Panels.toggleFocus(panel);
					});
					e.preventDefault();
					return;
				}
				// Close shortcuts modal if open
				var modal = $('#shortcuts-modal');
				if (modal && modal.style.display !== 'none') {
					modal.style.display = 'none';
					e.preventDefault();
					return;
				}
				return;
			}

			if (isInput) return;

			// Global hotkeys when not in an input
			if (e.key === '/' || e.key === 'f') {
				e.preventDefault();
				// Focus search on first visible panel
				var visibleInput = document.querySelector('article .panel-search-input');
				if (visibleInput) {
					visibleInput.focus();
					visibleInput.select();
				}
			} else if (e.key === 't') {
				e.preventDefault();
				var curTheme = GoAccess.AppPrefs.theme || 'darkGray';
				var newTheme = (curTheme === 'bright') ? 'darkGray' : 'bright';
				GoAccess.Nav.setTheme(newTheme);
				GoAccess.Toast.show('Theme: ' + newTheme, 'info', 1500);
			} else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
				e.preventDefault();
				var modal = $('#shortcuts-modal');
				if (modal) {
					modal.style.display = (modal.style.display === 'none') ? 'flex' : 'none';
				}
			} else if (e.key >= '1' && e.key <= '9') {
				var panels = Object.keys(GoAccess.getPanelUI());
				var idx = parseInt(e.key, 10) - 1;
				if (idx < panels.length) {
					var targetPanel = $('#panel-' + panels[idx]);
					if (targetPanel) {
						targetPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
						GoAccess.Toast.show('Jumped to ' + (GoAccess.getPanelUI(panels[idx])?.head || panels[idx]), 'info', 1200);
					}
				}
			}
		});

		// Modal close button
		$('#shortcuts-modal .shortcuts-close')?.addEventListener('click', function () {
			$('#shortcuts-modal').style.display = 'none';
		});
		$('#shortcuts-modal')?.addEventListener('click', function (e) {
			if (e.target === this) this.style.display = 'none';
		});
	}
};

// Adds the visibilitychange EventListener
document.addEventListener('visibilitychange', function () {
	// fires when user switches tabs, apps, etc.
	if (document.visibilityState === 'hidden')
		GoAccess.App.hasFocus = false;

	// fires when app transitions from hidden or user returns to the app/tab.
	if (document.visibilityState === 'visible' && GoAccess.isAppInitialized) {
		var hasFocus = GoAccess.App.hasFocus;
		GoAccess.App.hasFocus = true;
		hasFocus || GoAccess.App.renderData();
	}
});

// Init app
window.onload = function () {
	GoAccess.initialize({
		'i18n': window.json_i18n,
		'uiData': window.user_interface,
		'panelData': window.json_data,
		'wsConnection': window.connection || null,
		'prefs': window.html_prefs || {},
	});
};
}());
