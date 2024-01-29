var lang, config, nodejs, channel, app = document.querySelector('iframe').contentWindow

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
		this.isLoaded = {frontend: false, backend: false}
		this.localEmit = super.emit
		this.availableLanguages = {'en': 'English'}
		this.config = new BridgeConfig(this)
		this.on('get-lang', () => this.channelGetLangCallback())
		this.once('frontend', () => (...args) => this.loaded('frontend', ...args))
		this.once('backend', (...args) => this.loaded('backend', ...args))
		this.once('available-languages', (ret, locale) => {
			this.locale = locale
			this.availableLanguages = ret
		})
		if (window.cordova) {
			this.configureCordovaChannel()
			this.startNodeMainScript()
		} else {
			this.configureElectronChannel()
			this.channelGetLangCallback()
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
	startNodeMainScript() {
		window.parent.nodejs.start('main.js', err => {
			err && log(String(err))
			this.channelGetLangCallback()
			updateSplashProgress()
			console.log('Node main script loaded.')
		}, {
			redirectOutputToLogcat: true
		})
	}
	configureCordovaChannel() {
		fakeUpdateProgress()
		this.channel = window.parent.nodejs.channel
		this.channel.on('message', args => this.localEmit(...args))
	}
	configureElectronChannel() {
		const bridge = this
		class ElectronChannel extends EventEmitter {
			constructor() {
				super()
				this.originalEmit = this.emit.bind(this)
				this.emit = (...args) => parent.api.window.emit(...args)
				this.connect()
			}
			connect(){
				if(this.connected) return
				parent.api.window.on('message', args => bridge.localEmit(...args))
				this.connected = true
			}
			post(_, args) {
				this.connect()
				this.emit(...args)
			}
		}
		this.channel = new ElectronChannel()
	}
	channelGetLangCallback(){
		var next = lng => {
			if(!lng){
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
		if(window.cordova){
			navigator.globalization.getPreferredLanguage(language => next(language.value), () => next())
		} else {
			next()
		}
	}
    emit(...args){
        this.channel.post('message', Array.from(args))
    }
	waitBackend(f) {
		if(this.isLoaded.backend) return f()
		this.once('backend', f)
	}
	showItemInFolder(path) {
		parent.api && parent.api.openPath(path)
	}
	openExternalURL(url) {
		if (parent.navigator.app) {
			parent.navigator.app.loadUrl(url, { openExternal: true })
		} else if (parent.api) {
			parent.api.openExternal(url)
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
}, {once: true})
ifr.src = './app.html'