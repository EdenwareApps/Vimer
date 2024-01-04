const fs = require('fs'), path = require('path')
const { spawn } = require('child_process')
require('openai/shims/node')
const OpenAI = require('openai')

const FORBIDS = `
STRICT RULES:
- Do not change file names.
- Do not use the concat protocol (concat:file1|file2) or concat demuxer (-f concat), instead prefer the concat video filter (-filter_complex) if needed.
- Do not using command piping.
- Do not use wildcards (like \'%d\').
- Do not insert placeholders.
- Use only ffmpeg commands.
- If using -loop, set -t too to prevent looping endlessly.
- Use intermediary commands with temp files to reduce any command complexity.
- Do map not use same filter output twice in a command.
- Do not output multiple alternatives for the same command.
- Reduce the CPU usage of the command chain when possible.
`
const DESCRIBE_TASK_INSTRUCT = `Briefly define in '{1}' language, in a list, without introduction paragraph in the response, what will be done with the media file on each of the following commands:
'{0}'`
const FFMPEG_INSTRUCT = `Answer without an introduction paragraph or explanation with one or more FFmpeg commands that are necessary to do the following task:
Task: \`{0}\`.
Files available: {1}.
Output file should be named 'output.**' (replace '.**' with the most appropriated output format extension). Improve command for a better result for the requested task if that is something that is recommendable. `+ FORBIDS
const FFMPEG_IMPROVE_INSTRUCT = `Consider the following chain of commands:
\`{0}\`
Being used to attend the following request:
\`{1}\`
Then do these tasks:
- Analyze the commands for syntax errors.
- Compare the desired end results of the request to the command probable effects, looking for possible flaws in using this command to achieve this goal, predicting what could go different from the desired result.
- If flaws are found, find solutions to address it.
- After all the thoughts, use the separator '----' and then print a fixed/improved version of this command chain. `+ FORBIDS
const FFMPEG_IMPROVE_PROMPT = `Answer without an introduction paragraph or explanation. Consider the following request:
\`{0}\`
The provided files are: {1}
Imagine the desired end result through this request and improve the request by making it more detailed to prevent if from being misunderstood.`
const FFMPEG_FIX_INSTRUCT = `The FFmpeg command has exited with an error.
Command: \`{0}\`
Output: \`{1}\`
Generate a fixed version of this command to prevent the error present on output. Keep the same output file name. `+ FORBIDS

class Masker {
    constructor(){
        this.clear()
    }
    clear(){
        this.kmap = {}
        this.rmap = {}
    }
    process(files) {
        const keys = Object.keys(this.kmap)
        let i = keys.length
        files.forEach(f => {
            if(this.rmap[f.path]) return
            const ext = f.path.split('.').pop()
            i++
            this.kmap['input'+ i +'.'+ ext] = f.path
            this.rmap[f.path] = 'input'+ i +'.'+ ext
        })
    }
    map(files) {
        const ret = {}
        this.process(files)
        files.forEach(f => {
            ret[this.mask(f.path)] = f.path
        })
        return ret
    }
    mask(file) {
        return this.rmap[file] || file
    }
    unmask(fileKey) {
        return this.kmap[fileKey] || fileKey
    }
    maskCommand(cmd) {
        if(Array.isArray(cmd)) {
            return cmd.map(a => {
                return this.rmap[a] || a
            })
        }
        return this.maskText(cmd, this.kmap)
    }
    unmaskCommand(cmd) {
        if(Array.isArray(cmd)) {
            return cmd.map(a => {
                return this.kmap[a] || a
            })
        }
        return this.unmaskText(cmd, this.kmap)
    }
    maskText(prompt, masks) {
        if(!masks) {
            masks = this.kmap
        }
        prompt = prompt.replace(new RegExp('\\+', 'g'), '/')
        Object.keys(masks).forEach(name => {
            if(prompt.indexOf(masks[name]) != -1) {
                prompt = prompt.split(masks[name]).join(name)
            }
            const basename = path.basename(masks[name])
            if(prompt.indexOf(basename) != -1) {
                prompt = prompt.split(basename).join(name)
            }
        })
        return prompt
    }
    unmaskText(prompt, masks) {
        if(!masks) {
            masks = this.kmap
        }
        prompt = prompt.replace(new RegExp('\\+', 'g'), '/')
        Object.keys(masks).forEach(name => {
            if(prompt.indexOf(name) != -1) {
                prompt = prompt.split(name).join(masks[name])
            }
        })
        return prompt
    }
}

class FormatInfo {
    constructor() {
        this.info = require('./known-codecs.json')
    }
    validateCodec(codec, ext) {
        const type = this.getType(ext)
        if(type) {
            if(!this.info[type][ext].includes(codec)) {
                return this.info[type][ext][0]
            }
        }
        return codec
    }
    getType(ext) {
        let ret = ''
        Object.keys(this.info).some(type => {
            if(this.info[type][ext]) {
                ret = type
                return true
            }
        })
        return ret
    }
}

class Midas {
    constructor(){
        this.modelName = 'gpt-3.5-turbo'
        this.masker = new Masker()
        this.fmt = new FormatInfo()
        this.currentLanguage = 'English'
    }
    load(apiKey){
        if(this.openai && this.apiKey == apiKey) return
        this.apiKey = apiKey
        this.openai = new OpenAI({
            apiKey,
            maxRetries: 1
        })
        this.messages = []
    }
    async query(content, detached, role='user'){
        const message = { role, content }
        if(!detached) {
            this.messages.push(message)
        }
        console.log('QUERY='+ content)
        const ret = await this.openai.chat.completions.create({
            messages: detached ? [message] : this.messages.slice(this.messages.length - 3),
            temperature: 0.1,
            model: this.modelName
            // model: 'text-davinci-003'
        })
        return ret.choices[0].message.content
    }
    extractCommands(text) {
        let commands = text.match(new RegExp('ffmpeg.*([\n]|$)', 'gm'))
        if(!commands) return []
        return commands.map(c => {
            if(c.endsWith("'") || c.endsWith("`")) {
                c = c.substr(0, c.length - 1)
            }
            if(c.indexOf(' && ') != -1) {
                return c.split(' && ')
            }
            return c
        }).flat()
    }
    invalidCommandSyntax(cmd) { // prevent some common mistakes on improving step
        if(Array.isArray(cmd)) {
            let ret = false
            cmd.some(c => {
                ret = this.invalidCommandSyntax(c)
                return !!ret
            })
            return ret
        }
        if(cmd.indexOf(' -t ') == -1 && cmd.indexOf(' -loop ') != -1) { // prevent infinite input loops
            return 'Do not create infinite loops (-loop without -t).'
        }
        if(cmd.indexOf('"concat:') != -1) {
            return 'Do not use concat protocol, use concat video filter instead.'
        }
        if(cmd.indexOf('%d') != -1) {
            return 'Do not use concat protocol, use concat video filter instead.'
        }
        if(cmd.indexOf('-f concat') != -1) {
            return 'Do not use concat demuxer, use concat video filter instead.'
        }
        if(cmd.indexOf(' | ') != -1) {
            return 'Do not using command piping.'
        }
        return false
    }
    fixCommandSyntax(cmd) { // fix some common mistakes
        const ext = cmd.trim().split('.').pop().toLowerCase().replace(new RegExp('[^a-z0-9]+'), '')
        const type = this.fmt.getType(ext)
        let vmatch = cmd.match(new RegExp('\\-(vcodec|c\\:v) +([A-Za-z0-9]+)'))
        let amatch = cmd.match(new RegExp('\\-(acodec|c\\:a) +([A-Za-z0-9]+)'))
        if(type == 'audio') {
            if(vmatch) {
                cmd = cmd.replace(vmatch[0], '')
                vmatch = null
            }
            if(amatch) {
                const rcodec = this.fmt.validateCodec(amatch[2], ext)
                if(rcodec && rcodec != amatch[2]) {
                    cmd = cmd.replace(amatch[0], '-'+ amatch[1] +' '+ rcodec)
                    amatch[2] = rcodec
                }
            }
        }
        if(type == 'image' && amatch) {
            cmd = cmd.replace(amatch[0], '')
            amatch = null
        }
        if(vmatch) {
            const rcodec = this.fmt.validateCodec(vmatch[2], ext)
            if(rcodec && rcodec != vmatch[2]) {
                cmd = cmd.replace(vmatch[0], '-'+ vmatch[1] +' '+ rcodec)
                vmatch[2] = rcodec
            }
        }
        return cmd
    }
    async iquery(prompt, files) {
        let receivedCommands
        const improvementRounds = 1
        
        //const iprompt = await this.query(FFMPEG_IMPROVE_PROMPT.format(prompt, files), true)
        //console.error('IMPROVED PROMPT='+ JSON.stringify(iprompt))
        
        for(let retries = 2; retries > 0; retries--) {
            const ret = await this.query(FFMPEG_INSTRUCT.format(prompt, files), true)
            receivedCommands = this.extractCommands(ret)
            const err = this.invalidCommandSyntax(receivedCommands)
            if(err) {
                receivedCommands = undefined
                if(!retries) {
                    throw err
                }
            } else {
                break
            }
        }
                
        console.error('GOT INSTRUCTIONS='+ JSON.stringify({receivedCommands}))
        for(let i=0; i<improvementRounds; i++) {
            const descrition = await this.describe(receivedCommands, 'English')
            const iret = await this.query(FFMPEG_IMPROVE_INSTRUCT.format(receivedCommands.join("\n"), prompt, descrition), true)
            console.log('IMPROVE FEEDBACK='+ iret)
            const improvedCommands = this.extractCommands(iret.split('----').pop())
            console.log("IMPROVED COMMANDS=\n"+ improvedCommands.join("\n"))
            if(improvedCommands && improvedCommands.length) {
                const err = this.invalidCommandSyntax(improvedCommands)
                if(err) {
                    console.error('IMPROVEMENTS DISCARDED', err)
                    continue
                }
                receivedCommands = improvedCommands
            }
        }

        return receivedCommands
    }
    async getFFmpegCommands(prompt, files) {
        const masks = this.masker.map(files)
        const maskedPrompt = this.masker.maskText(prompt, masks)
        const filePaths = files.map(f => f.path)
        const receivedCommands = await this.iquery(
            maskedPrompt,
            Object.keys(masks).map(m => {
                let info
                files.some(f => {
                    if(f.path == masks[m]) {
                        info = f.info
                        return true
                    }
                })
                if(info) m += ' ('+ info +')'
                return m
            }).join(', ') +'.'
        )
        const commands = receivedCommands.
            map(s => this.fixCommandSyntax(s)).
            map((s, i) => this.adjustFFmpegCommand(s, filePaths.slice(Math.min(filePaths.length - 1, i)), masks))
        console.error('COMMANDS='+ JSON.stringify({commands}))
        const description = this.skipDescription ? '' : (await this.describe(commands))
        return {commands, description}
    }
    async describe(commands, language) {
        return await this.query(DESCRIBE_TASK_INSTRUCT.format(commands.join("\n"), language || this.currentLanguage), true)
    }
    getExt(file, referenceFile) {
        const receivedExt = file.split('.').pop()
        if(receivedExt.length >= 2 && receivedExt.length <= 5 && receivedExt != '**') {
            return receivedExt
        }
        if(referenceFile) {
            return this.getExt(referenceFile)
        }
        return 'mp4' // last resort
    }
    async fixFFmpegCommand(opts) { // {cmd, output}
        let output = opts.output.split("\n").map(s => s.trim()).filter(s => s)
        output = this.masker.maskText(output.slice(output.length - 8).join("\n"))
        const cmd = this.masker.maskCommand(opts.cmd)
        const ret = await this.query(FFMPEG_FIX_INSTRUCT.format(cmd, output), false)
        console.log('FIXING FEEDBACK=', ret)
        const receivedCommands = this.extractCommands(ret)
        return this.masker.unmaskCommand(receivedCommands.pop())
    }
    adjustFFmpegCommand(cmd, files, masks) {
        let ii = 1
        const outputMatches = cmd.match(new RegExp('([_\\-A-Za-z0-9]*(output|temp)[0-9]*\\.[_\\-\\*A-Za-z0-9]+)', 'g'))
        outputMatches && outputMatches.forEach((outputName, i) => {
            const file = files[i] || files[files.length - 1]
            const baseLocalOutputfileName = file.replace(new RegExp('.vimer[0-9\\-]*.'), '.')
            const outputExt = this.getExt(outputName, file)
            let localOutputFile = baseLocalOutputfileName.replace(new RegExp('\\.([A-Za-z0-9]{2,5})$'), '.vimer-'+ ii +'.'+ outputExt)
            while(fs.existsSync(localOutputFile)) {
                ii++
                localOutputFile = baseLocalOutputfileName.replace(new RegExp('\\.([A-Za-z0-9]{2,5})$'), '.vimer-'+ ii +'.'+ outputExt)
            }
            this.masker.process([{path: localOutputFile}])
            cmd = cmd.replace('"'+ outputName +'"', outputName) // unquote
            cmd = cmd.replace(outputName, '"'+ localOutputFile +'"')
        })
        Object.keys(masks).forEach(mask => {
            cmd = cmd.replace('"'+ mask +'"', mask) // unquote
            cmd = cmd.replace(mask, '"'+ masks[mask] +'"')
        })
        return cmd.trim()
    }
    clear() {
        this.messages = []
        this.masker.clear()
    }
}

module.exports = Midas
