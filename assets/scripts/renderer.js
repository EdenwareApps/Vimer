// renderer/index.js

var currentStep = 1
function step(n) {
    if(currentStep <= 90) { // 90+ steps are to detached dialogs
        previousStep = currentStep
    }
    currentStep = n
    const s = document.querySelector('#step-'+ n)
    document.querySelector('#content').scrollTop = s.offsetTop
    let header = n > 1
    if(!header && document.querySelector('#file-list div')) {
        header = true
    }
    s.querySelector('.screen-container').scrollTop = 0
    document.querySelector('body').className = header ? 'header' : ''
}

function langUpdated(){
    Array.from(document.querySelectorAll('[data-language]')).forEach(e => {
        const key = e.getAttribute('data-language'), tag = e.tagName.toLowerCase(), val = app.lang[key] || key
        if(!key) return
        const text = val.replace(new RegExp('\r?\n', 'g'), '<br />')
        const plainText = val.replace(new RegExp('[\r\n]+', 'g'), ' ')
        if(tag == 'textarea' || (tag == 'input' && e.type == 'text')) {
            e.placeholder = plainText
        } else {
            e.innerHTML = text
        }
        e.title = plainText
    })
    const about = app.lang.ABOUT.replace('{0}', 'Vimer') +' v'+ app.manifest.version
    const optIcons = document.querySelectorAll('#options-icon a')
    document.querySelector('#step-98 h1').innerText = about
    document.querySelector('#step-98 p').innerText = app.lang.ABOUT_VIMER.replace('{0}', 'Vimer (VIdeo transforMER)')
    optIcons[0].title = app.lang.OPTIONS
    optIcons[1].title = about
}

function fileListUpdated() {
    const hasFiles = document.querySelector('#file-list div')
    const buttons = document.querySelectorAll('#step-1 label.button, #step-1 label.sub-button, #step-1 button')
    const body = document.querySelector('body')
    if(hasFiles) {
        buttons[0].querySelector('font').innerHTML = app.lang.ADD_MORE_FILES
        buttons[0].className = 'sub-button'
        buttons[1].style.display = 'inline-block'
        body.className = 'header'
    } else {
        buttons[0].querySelector('font').innerHTML = app.lang.SELECT_MEDIA_FILES
        buttons[0].className = 'button'
        buttons[1].style.display = 'none'
        body.className = ''
    }
}

function removeFileFromList(item) {
    item.parentNode.removeChild(item)
    fileListUpdated()
}

function validateUserPrompt() {
    const prompt = document.querySelector('#userPrompt').value
    if(prompt.length > 10) {
        step(3)
        app.emit('win-progress', 0, 'indeterminate')
        midas().then(ret => {
            document.querySelector('#review-commands').value = ret.commands.join("\n\n")
            document.querySelector('#review-commands-description').innerText = ret.description
            currentCommandData = ret
            if(app.config.get('skip-command-review') === true) {
                confirmReviewCommands()
            } else {
                step(4)
            }
        }).catch(err => {
            step(2)
            app.emit('win-progress', 1, 'error')
            alert(err)
        }).finally(() => {
            app.emit('win-progress', 0, 'none')
        })
        showReviewCommands(false)
    } else {
        step(2)
        alert(app.lang.ENHANCE_DESCRIPTION)
    }
}

function validateCommandOutput(cmd, output) {
    return new Promise((resolve, reject) => {
        const uid = parseInt(Math.random() * 10000000)
        app.once('midas-validated-'+ uid, ret => {
            console.warn('VALIDATION', ret)
            if(ret.err) return reject(ret.err)
            resolve(ret)
        })
        app.emit('midas-validate', {uid, cmd, output})
        console.warn('VALIDATING', {uid, cmd, output})
    })
}

function trimQuotes(file) {
    if(file.startsWith('"') || file.startsWith("'")) {
        file = file.substr(1)
    }
    if(file.endsWith('"') || file.endsWith("'")) {
        file = file.substr(0, file.length - 1)
    }
    return file
}

var currentCommand, currentCommandData
function confirmReviewCommands() {
    step(5)
    let progress = 0
    const pr = document.querySelector('#command-progress-percentage')
    const cmds = document.querySelector('#review-commands').value.split("\n").filter(s => s.trim().length)
    const queue = currentCommand = new parent.ffmpeg.Queue(cmds, {
        validator: validateCommandOutput,
        workDir: app.paths.temp
    })
    const map = () => {
        const already = []
        return queue.processes.map((p, i) => ({i, file: trimQuotes(p.cmd[p.cmd.length - 1])})).filter(r => {
            if(r.file.indexOf('/') == -1) return false // temp file?
            if(already.includes(r.file)) return false // dupe
            already.push(r.file)
            return true
        })
    }
    app.emit('win-progress', 0, 'indeterminate')
    queue.on('progress', p => {
        pr.innerText = parseInt(p) +'%'
        progress = p / 100
        app.emit('win-progress', progress, 'normal')
    })
    queue.start().then(() => {
        let content = app.lang.SAVED_ON +'<br />'
        currentCommandData.outputFiles.forEach(file => {
            content += '<div><i class="fas fa-check-circle" aria-hidden="true"></i> <a href="javascript:;" onclick="app.showItemInFolder(\''+ file +'\')">'+ file +'</a></div>'
        })
        content += '<br />'+ app.lang.TASK_FINISHED_HINT.replace('{0}', app.lang.REVIEW_COMMANDS) +'<br /><br />'
        document.querySelector('#result-message').innerHTML = content
        step(6)
    }).catch(err => {
        if(err != 'Aborted') {
            app.emit('win-progress', progress, 'error')
            step(1)
            console.error(err)
            alert(err)
        }
    }).finally(() => {   
        app.emit('delete-temp-files', currentCommandData.tempFiles)
        if(app.config.get('save-log-files')) {
            app.emit('save-log-file', currentCommandData.outputFiles[currentCommandData.outputFiles.length - 1] +'.log', queue.processes.map((p, i) => {
                return 'ffmpeg '+ p.cmd.join(' ') +"\n\n"+ queue.outputs[i]
            }).join("\n\n"))
        }
    })
    showReviewCommands(false)
}

function newTask() {
    clearFileList()
    app.emit('midas-clear')
    app.emit('win-progress', 0, 'none')
    step(1)
}

function cancelCurrentCommand() {
    step(2)
    currentCommand.abort()
    app.emit('win-progress', 0, 'none')
}

function showReviewCommands(show) {
    const r = document.querySelector('#review')
    const a = r.querySelector('a')
    const t = r.querySelector('textarea')
    a.style.display = show ? 'none' : 'inline-block'
    t.style.display = show ? 'inline-block' : 'none'
}

var currentMidasInfo
function midas() {
    const uid = parseInt(Math.random() * 1000000)
    const prompt = document.querySelector('#userPrompt').value
    const files = getFileList()
    return new Promise((resolve, reject) => {
        app.once('midas-generated-'+ uid, ret => {
            currentMidasInfo = ret
            console.warn('RET', ret)
            if(ret.err) return reject(ret.err)
            resolve(ret)
        })
        app.emit('midas-generate', {
            prompt, uid, files
        })
    })
}

function forwardSlashes(path) {
    if(path && path.indexOf('\\') != -1){
        return path.replace(new RegExp('\\\\+', 'g'), '/')
    }
    return path
}

function getFileList() {
    return Array.from(document.querySelectorAll('#file-list div')).map(f => {
        return {
            name: f.getAttribute('data-name'),
            info: f.getAttribute('data-info') || '',
            path: forwardSlashes(f.getAttribute('data-path'))
        }
    })
}

var previousStep = 1
function loadOptions(opts={}) {
    document.querySelector('#openai-api-key').value = app.config.get('openai-api-key') || ''
    document.querySelector('#openai-model-name').value = app.config.get('openai-model-name') || ''
    document.querySelector('#save-log-files').checked = app.config.get('save-log-files') === true
    document.querySelector('#skip-command-review').checked = app.config.get('skip-command-review') === true
    document.querySelector('#command-optimization-level').selectedIndex = app.config.get('command-optimization-level') || 0
    document.querySelector('#locale').innerHTML = Object.keys(app.availableLanguages).map(k => {
        const selected = k == app.locale ? 'selected' : ''
        return '<option value="'+ k +'" '+ selected +'>'+ app.availableLanguages[k] +'</option>'
    }).join('')
    const hasKey = document.querySelector('#openai-api-key').value && !opts.badApiKey
    document.querySelector('#openai-api-key').style.border = '1px solid '+ (hasKey ? '#bab0bf' : '#b02')
    step(99)
}

function saveOptions() {
    const k = document.querySelector('#openai-api-key')
    const m = document.querySelector('#openai-model-name')
    const l = document.querySelector('#locale')
    const s = document.querySelector('#skip-command-review')
    const g = document.querySelector('#save-log-files')
    const c = document.querySelector('#command-optimization-level')
    app.config.set('openai-api-key', k.value.trim())
    app.config.set('openai-model-name', m.value.trim())
    app.config.set('locale', l.querySelectorAll('option')[l.selectedIndex].value)
    app.config.set('command-optimization-level', c.querySelectorAll('option')[c.selectedIndex].value)
    app.config.set('skip-command-review', s.checked)
    app.config.set('save-log-files', g.checked)
    leaveScreen()
}

function leaveScreen() {
    if(currentStep >= 90) {
        step(previousStep)
    }
}

function previousScreen() {
    step(previousStep)
}

function switchScreen(n) {
    if(currentStep != n) {
        if(n == 99) {
            loadOptions()
        } else {
            step(n)
        }
    } else {
        leaveScreen()
    }
}

function clearFileList() {
    document.querySelector('#file-list').innerHTML = ''
    fileListUpdated()
}

function parseFileInfo(info) {
    let ret = []
    Object.keys(info).forEach(k => {
        if(info[k]) {
            let n = info[k]
            if(k == 'codecs') n = Object.values(n).filter(s => s).join(',')
            else if(k == 'duration') n += ' secs'
            ret.push(k +': '+ n)
        }
    })
    return ret.join(', ')
}

async function getFilesInfo(files) {
    for(const file of Object.keys(files)) {
        let err
        if(!parent.ffmpeg.opts.workDir) {
            parent.ffmpeg.opts.workDir = app.paths.temp
        }
        const info = await parent.ffmpeg.getInfo(file).catch(e => err = e)
        if(!err) {
            files[file].setAttribute('data-info', parseFileInfo(info))
        }
    }
}

window.addEventListener('resize', () => step(currentStep))

document.querySelector('#file-input').addEventListener('change', event => {
    const files = Array.from(event.target.files).map(f => ({name: f.name, path: f.path}))
    const fileList = document.querySelector('#file-list')
    let i = fileList.querySelectorAll('div').length
    let newFiles = {}
    for(const file of files) {
        if(!fileList.querySelector('div[data-path="'+ file.path +'"]')) {
            i++
            const div = document.createElement('div')
            div.setAttribute('data-path', file.path)
            div.setAttribute('data-name', file.name)
            div.innerHTML = '<span class="file-list-order">'+ i +'&ordm;</span><span class="file-list-name">'+ file.name +'</span><a href="javascript:;" class="file-list-close"><i class="fas fa-times" aria-hidden="true"></i></a>'
            div.querySelector('a').addEventListener('click', () => removeFileFromList(div))
            fileList.appendChild(div)
            newFiles[file.path] = div
        }
    }
    getFilesInfo(newFiles).catch(console.error)
    fileListUpdated()
})

function loaded() {
    langUpdated()
    app.on('ask-openai-api-key', () => {
        loadOptions({badApiKey: true})
        const b = document.querySelector('#options-back-button')
        b.style.display = 'none'
        if(!window.originalSaveOptions) {
            window.originalSaveOptions = saveOptions
        }
        saveOptions = () => {
            b.style.display = 'inline-block'
            saveOptions = window.originalSaveOptions
            saveOptions()
        }
    })
    app.on('new-version', (versions, url) => {
        if(confirm(app.lang.NEW_VERSION_AVAILABLE)) {
            app.openExternalURL(url)
        }
    })
}