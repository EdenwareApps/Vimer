global.cordova = false

const Mod = require('module')
const req = Mod.prototype.require
Mod.prototype.require = function () { // compat for 'openai' module with older Electron versions
    if(arguments[0].startsWith('node:')) {
        arguments[0] = arguments[0].substr(5)
    }
    return req.apply(this, arguments)
}

try {
    if(require.resolve('cordova-bridge')){
        global.cordova = require('cordova-bridge')
    }
} catch(e) {
    global.cordova = false
}

if(!global.cordova){    
    const electron = require('electron')
    if(typeof(electron) == 'string'){ // get electron path and relaunch from it
        const { spawn } = require('child_process')
        spawn(electron, [__filename], { detached: true, stdio: 'ignore' }).unref()
        process.exit()
    }
}

const fs = require('fs')

global.APPDIR = String(__dirname || process.cwd()).replace(new RegExp('\\\\', 'g'), '/')
global.MANIFEST = require('./package.json')

require('./modules/supercharge')(global)

if(global.cordova){
    let datadir = global.cordova.app.datadir(), temp = path.join(path.dirname(datadir), 'cache')
    global.paths = {data: datadir +'/Data', temp}
} else {
    if(fs.existsSync(global.APPDIR +'/.portable') && checkDirWritePermissionSync(global.APPDIR +'/.portable')) {
        global.paths = {data: global.APPDIR +'/.portable/Data', temp: global.APPDIR +'/.portable/temp'}
    } else {
    	global.paths = require('env-paths')(global.MANIFEST.window.title, {suffix: ''})
    }
}

Object.keys(global.paths).forEach(k => {
    global.paths[k] = forwardSlashes(global.paths[k])
    console.log('DEFAULT PATH ' + k + '=' + global.paths[k])
    fs.mkdir(global.paths[k], {}, () => {})
})

const Midas = require('./modules/midas')
const Bridge = require('./modules/bridge')

global.config = require('./modules/config')(global.paths['data'] + '/config.json')
global.midas = new Midas()

function askOpenAIKey() {
    return new Promise(resolve => {
        global.ui.emit('ask-openai-api-key')
        global.ui.once('config-set', () => resolve())
    })
}

async function midasGenerate(opts) {
    if(!global.config.get('openai-api-key')) await askOpenAIKey()
    global.midas.load(global.config.get('openai-api-key'))
    let err
    const currentModelName = global.config.get('openai-model-name')
    if(currentModelName && currentModelName != global.midas.modelName) {
        global.midas.modelName = currentModelName
    }
    global.midas.skipDescription = global.config.get('skip-command-review')
    global.midas.currentLanguage = global.lang.LANGUAGE_NAME +' ('+ global.lang.locale.toUpperCase() +')'
    const ret = await global.midas.getFFmpegCommands(opts.prompt, opts.files).catch(e => err = e)
    if(err) {
        if(String(err).indexOf('API key') != -1) {
            await askOpenAIKey()
            global.midas.load(global.config.get('openai-api-key'))
            return await midasGenerate(opts)
        } else {
            global.ui.emit('midas-generated-'+ opts.uid, {err: err.message +' '+ err.stack})
        }
        return
    }
    console.log(ret)
    global.ui.emit('midas-generated-'+ opts.uid, ret)
}

async function midasValidate(opts) {
    console.log('MIDAS VALIDATE')
    const rxp = '(failed to open|unable to find a suitable|error initializing|has an unconnected output|conversion failed|unrecognized option|cannot be used together)'
    if(opts.output.match(new RegExp(rxp, 'i'))) {
        let err
        const ret = await global.midas.fixFFmpegCommand(opts).catch(e => err = e)
        console.log('MIDAS VALIDATE FIXED', ret)
        if(err) {
            global.ui.emit('midas-validated-'+ opts.uid, {err: err.message +' '+ err.stack})
            return false
        }
        console.log(ret)
        global.ui.emit('midas-validated-'+ opts.uid, ret)
    } else {
        global.ui.emit('midas-validated-'+ opts.uid, true)
    }
    return true
}

async function checkForUpdates() {
    const axios = require(APPDIR+'/node_modules/axios/dist/node/axios.cjs')
    const endpoint = 'https://edenware.app/vimer/config.json'
    const ret = await axios.get(endpoint)
    if(ret.data.version && ret.data.version > global.MANIFEST.version) {
        global.ui.emit('new-version', {
            update: ret.data.version,
            current: global.MANIFEST.version
        }, ret.data.update_url)
    }
}

async function createWindow() {
    const { app, BrowserWindow } = require('electron')

    await app.whenReady()
    const win = new BrowserWindow({
        width: 800,
        height: 500,
        autoHideMenuBar: true,
        webPreferences: {
            defaultEncoding: 'UTF-8',
            cache: false,
            sandbox: false,
            fullscreenable: true,
            disablePreconnect: true,
            dnsPrefetchingEnabled: false,
            contextIsolation: false, // false is required for nodeIntegration
            nodeIntegration: true,
            nodeIntegrationInWorker: false,
            nodeIntegrationInSubFrames: false,
            enableRemoteModule: true,
            experimentalFeatures: true, // audioTracks support
            webSecurity: false // desabilita o webSecurity
        }
    })
    win.setMenuBarVisibility(false)
    win.loadFile('index.html')
    global.ui = new Bridge({win, config})
    global.ui.on('midas-generate', midasGenerate)
    global.ui.on('midas-validate', midasValidate)
    global.ui.on('midas-clear', () => global.midas.clear()) // clear conversation
    global.ui.on('win-progress', (p, mode) => win.setProgressBar(p, {mode}))
    global.ui.on('save-log-file', (file, log) => {
        console.log('SAVELOG', file)
        fs.writeFile(file, log, err => err && console.error(err))
    })
    setTimeout(() => checkForUpdates().catch(console.error), 3000)
}

createWindow().catch(console.error)