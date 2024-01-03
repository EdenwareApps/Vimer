
class EventEmitter {
	constructor() {
		this.events = {};
	}
	on(event, listener) {
		if (typeof this.events[event] !== 'object') {
			this.events[event] = [];
		}
		this.events[event].push(listener);
		return () => this.removeListener(event, listener);
	}
	removeListener(event, listener) {
		if (typeof this.events[event] === 'object') {
			const idx = this.events[event].indexOf(listener);
			if (idx > -1) {
				this.events[event].splice(idx, 1);
			}
		}
	}
	removeAllListener(event) {
		delete this.events[event]
	}
	listenerCount(event) {
		return this.events[event].length
	}
	listeners(event) {
		return this.events[event] ? this.events[event].slice(0) : []
	}
	emit(event, ...args) {
		if (typeof this.events[event] === 'object') {
			this.events[event].forEach(listener => listener.apply(this, args))
		}
	}
	once(event, listener) {
		const remove = this.on(event, (...args) => {
			remove();
			listener.apply(this, args);
		});
	}
}

class BridgeConfig extends EventEmitter {
	constructor(master) {
		super()
		this.master = master
		this.data = {}
		this.master.on('config', data => {
			this.data = data
			if(data.locale) this.locale = data.locale
			this.master.localEmit('change', this.data)
		})
	}
	get(key) {
		return this.data[key] || undefined
	}
	set(key, data) {
		this.master.emit('config-set', key, data)
	}
}

class BridgeClient extends EventEmitter {
	constructor() {
		super()
		this.localEmit = super.emit
		this.availableLanguages = {'en': 'English'}
		this.config = new BridgeConfig(this)
		this.isLoaded = {frontend: false, backend: false}
		this.once('backend-ready', (...args) => this.loaded('backend', ...args))
		this.once('available-languages', (ret, locale) => {
			this.locale = locale
			this.availableLanguages = ret
		})
		this.on('get-lang', () => this.channelGetLangCallback())
		this.on('lang', (texts, locale) => {
			this.lang = texts
			this.locale = locale
		})
		if (window.cordova) {
			this.configureCordovaChannel()
		} else {
			this.configureElectronChannel()
		}		
	}
	loaded(origin, ...args) {
		this.isLoaded[origin] = true
		if (origin == 'backend') {
			this.config.data = args[0]
			this.lang = args[1]
			this.paths = args[2]
			this.manifest = args[3]
			this.localEmit('backend', ...args)
		}
		if (this.isLoaded.frontend && this.isLoaded.backend) {
			this.localEmit('load')
		}
	}
	configureCordovaChannel() {
		this.channel = window.nodejs.channel
		this.channel.on('message', (...args) => {
			this.channelCallback.apply(this, args[0])
		})
		window.nodejs.start('main.js', err => {
			err && this.localEmit('log', String(err))
			this.channelGetLangCallback()
			console.log('Node main script loaded.')
		}, {
			redirectOutputToLogcat: true
		})
	}
	configureElectronChannel() {
		const bridgeChannel = this
		class ElectronChannel extends EventEmitter {
			constructor() {
				super()
				this.electron = require('electron')
				this.originalEmit = this.emit.bind(this)
				this.emit = (...args) => this.post('', Array.from(args))
				this.connect()
			}
			connect() {
				if (this.connected) return
				this.io = this.electron.ipcRenderer
				this.io.on('message', (...args) => {
					bridgeChannel.channelCallback.apply(bridgeChannel, args.slice(1))
				})
				this.connected = true
			}
			post(_, args) {
				this.connect()
				if (this.io) {
					this.io.send('message', args)
				} else {
					console.error('POST MISSED?', JSON.stringify({_, args}))
				}
			}
		}
		this.channel = new ElectronChannel()
		this.channelGetLangCallback()
	}
	showItemInFolder(path) {
		this.channel.electron && this.channel.electron.shell.openPath(path)
	}
	channelCallback(...args) {
		setTimeout(() => { // async to prevent blocking main
			this.localEmit.apply(this, Array.from(args))
		}, 0)
	}
	channelGetLangCallback() {
		var next = lng => {
			if (!lng) {
				lng = window.navigator.userLanguage || window.navigator.language
			}
			// prevent "Intl is not defined"
			this.emit('get-lang-callback',
				lng,
				{
					name: (Intl || parent.Intl).DateTimeFormat().resolvedOptions().timeZone,
					minutes: (new Date()).getTimezoneOffset() * -1
				},
				window.navigator.userAgent,
				window.navigator.onLine
			)
		}
		if (window.cordova) {
			navigator.globalization.getPreferredLanguage(language => next(language.value), () => next())
		} else {
			next()
		}
	}
	emit() {
		this.channel.post('message', Array.from(arguments))
	}
	openExternalURL(url) {
		if (parent.navigator.app) {
			parent.navigator.app.loadUrl(url, { openExternal: true })
		} else if (this.channel.electron && this.channel.electron.shell) {
			this.channel.electron.shell.openExternal(url)
		} else {
			window.open(url)
		}
	}
}

var appChannel, ifr = document.querySelector('iframe')
ifr.addEventListener('load', function () {
	const app = ifr.contentWindow
	app.app = appChannel = new BridgeClient(ifr)
	appChannel.on('load', () => app.loaded())
	appChannel.on('lang', () => setTimeout(() => app.langUpdated(), 0))
	appChannel.loaded('frontend')
})
ifr.src = './app.html'