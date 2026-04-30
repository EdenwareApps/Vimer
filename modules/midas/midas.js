const fs = require('fs'), path = require('path')
const axios = require('axios')
const Prompts = require('./prompts')

const PROVIDER_ENDPOINTS = {
    openai: 'https://api.openai.com/v1',
    claude: 'https://api.anthropic.com/v1',
    gemini: 'https://generativelanguage.googleapis.com/v1',
    grok: 'https://api.grok.x.ai/v1',
    deepseek: 'https://api.deepseek.com'
}

const PROVIDER_DEFAULT_MODELS = {
    deepseek: 'deepseek-v4-pro'
}

const PROVIDER_ADAPTERS = {
    openai: {
        buildRequest({ endpoint, apiKey, model, messages, temperature }) {
            const base = (endpoint || PROVIDER_ENDPOINTS.openai).replace(/\/+$/, '')
            return {
                url: base + '/chat/completions',
                headers: {
                    'Authorization': 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                data: {
                    model,
                    messages,
                    temperature
                }
            }
        },
        parseResponse(body) {
            return body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || ''
        }
    },
    claude: {
        buildRequest({ endpoint, apiKey, model, messages, temperature }) {
            const base = (endpoint || PROVIDER_ENDPOINTS.claude).replace(/\/+$/, '')
            return {
                url: base + '/messages',
                headers: {
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json'
                },
                data: {
                    model,
                    max_tokens: 1024,
                    temperature,
                    messages: messages.map(m => ({
                        role: m.role === 'assistant' ? 'assistant' : 'user',
                        content: m.content
                    }))
                }
            }
        },
        parseResponse(body) {
            return String(body?.content?.[0]?.text || '')
        }
    },
    gemini: {
        buildRequest({ endpoint, apiKey, model, messages, temperature }) {
            const base = (endpoint || PROVIDER_ENDPOINTS.gemini).replace(/\/+$/, '')
            const text = messages.map(m => {
                const prefix = m.role === 'assistant' ? 'Assistant:' : m.role === 'system' ? 'System:' : 'User:'
                return prefix + ' ' + m.content
            }).join('\n')
            return {
                url: base + '/models/' + encodeURIComponent(model) + ':generateContent',
                headers: {
                    'Authorization': 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                data: {
                    contents: [
                        {
                            parts: [{ text }]
                        }
                    ],
                    temperature
                }
            }
        },
        parseResponse(body) {
            return body?.candidates?.[0]?.content?.parts?.[0]?.text || ''
        }
    },
    deepseek: {
        buildRequest({ endpoint, apiKey, model, messages, temperature }) {
            const base = (endpoint || PROVIDER_ENDPOINTS.deepseek).replace(/\/+$/, '')
            return {
                url: base + '/chat/completions',
                headers: {
                    'Authorization': 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                data: {
                    model,
                    messages,
                    temperature
                }
            }
        },
        parseResponse(body) {
            return body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || ''
        }
    },
    grok: {
        buildRequest({ endpoint, apiKey, model, messages, temperature }) {
            const base = (endpoint || PROVIDER_ENDPOINTS.grok).replace(/\/+$/, '')
            return {
                url: base + '/chat/completions',
                headers: {
                    'Authorization': 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                data: {
                    model,
                    messages,
                    temperature
                }
            }
        },
        parseResponse(body) {
            return body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || ''
        }
    }
}

class Masker {
    constructor(){
        this.clear()
    }
    clear(){
        this.kmap = {}
        this.rmap = {}
    }
    process(files) {
        files.forEach(f => {
            if(this.rmap[f.path]) return
            const ext = f.path.split('/').pop().split('.').pop()
            const name = path.basename(f.path)
            const basename = name.substr(0, name.length - (ext.length + 1)).replace(new RegExp(' +', 'g'), '_')
            let i = 1, mask = basename +'.'+ ext
            while(this.kmap[mask]) {
                mask = basename + i +'.'+ ext
                i++
            }
            this.kmap[mask] = f.path
            this.rmap[f.path] = mask
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
    set(mask, file) {
        this.kmap[mask] = file
        this.rmap[file] = mask
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
        prompt = prompt.replace(new RegExp('\\\\+', 'g'), '/')
        Object.keys(masks).forEach(name => {
            if(prompt.indexOf(masks[name]) != -1) {
                prompt = prompt.split(masks[name]).join(name)
            }
            const basename = path.basename(masks[name])
            if(prompt.indexOf(basename) != -1) {
                prompt = prompt.split(basename).join(name)
            }
        })
        return prompt.trim()
    }
    unmaskText(prompt, masks) {
        if(!masks) {
            masks = this.kmap
        }
        prompt = prompt.replace(new RegExp('\\\\+', 'g'), '/')
        Object.keys(masks).forEach(name => {
            if(prompt.indexOf('"'+ name +'"') != -1) {
                prompt = prompt.split('"'+ name +'"').join(name)
            }
            if(prompt.indexOf(name) != -1) {
                const rname = masks[name].indexOf(' ') == -1 ? masks[name] : '"'+ masks[name] +'"'
                prompt = prompt.split(name).join(rname)
            }
        })
        return prompt
    }
    unquote(file) {
        if(file.startsWith('"') || file.startsWith("'")) {
            file = file.substr(1)
        }
        if(file.endsWith('"') || file.endsWith("'")) {
            file = file.substr(0, file.length - 1)
        }
        return file
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
    constructor(opts={}){
        this.opts = Object.assign({
            modelName: 'gpt-4o-mini',
            language: 'English'
        }, opts)
        this.masker = new Masker()
        this.fmt = new FormatInfo()
    }
    load(apiKey, provider='openai', endpoint=''){
        if(this.apiKey == apiKey && this.provider == provider && this.endpoint == endpoint) return
        this.apiKey = apiKey
        this.provider = provider || 'openai'
        this.endpoint = endpoint || ''
        this.messages = []
        if(this.provider == 'deepseek'){
            const currentModel = String(this.opts.modelName || '').trim()
            if(!currentModel || currentModel.indexOf('deepseek') !== 0) {
                this.opts.modelName = PROVIDER_DEFAULT_MODELS.deepseek
            }
        }
        this.openai = null
    }
    async query(content, detached, role='user'){
        const message = { role, content }
        if(!detached) {
            this.messages.push(message)
        }
        const messages = detached ? [message] : this.messages.slice(-6)
        const adapter = PROVIDER_ADAPTERS[this.provider] || PROVIDER_ADAPTERS.openai
        const request = adapter.buildRequest({
            endpoint: this.endpoint,
            apiKey: this.apiKey,
            model: this.opts.modelName,
            messages,
            temperature: 0.1
        })
        console.log('QUERY('+ this.provider +')='+ content)
        const response = await axios.post(request.url, request.data, {
            headers: request.headers,
            timeout: 120000
        })
        const text = adapter.parseResponse(response.data)
        if(!text){
            throw new Error('Unsupported response format from '+ this.provider)
        }
        return text
    }
    extractResult(text) {
        console.log("EXTRACTING COMMANDS FROM="+ text)
        let start = text.indexOf('{'), end = text.lastIndexOf('}')
        while(start != -1 && end != -1) {
            const json = text.substr(start, end - start + 1)
            try {
                const result = JSON.parse(json)
                if(!result || !result.commands) throw 'Bad JSON format.'
                if(!result.tempFiles || !Array.isArray(result.tempFiles)) {
                    result.tempFiles = []
                } else {
                    result.tempFiles = result.tempFiles.filter(f => !result.outputFiles.includes(f))
                }
                return result
            } catch(e) {
                start = text.indexOf('{', start + 1)
            }
        }
        return false
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
        if(!cmd.match(new RegExp('^[\\./]*ffmpeg'))) { // prevent infinite input loops
            return 'Not a FFmpeg command.'
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
        const devNull = '/dev/null'
        if(cmd.indexOf(devNull) != -1) {
            cmd = cmd.replace(devNull, 'devnull.mp4')
        }
        return cmd
    }
    async iquery(prompt, files) {
        let result
        const optimizationLevel = global.config.get('command-optimization-level')
        const improvePrompt = optimizationLevel > 1
        const improvementsCount = improvePrompt ? (optimizationLevel - 1) : optimizationLevel
        
        if(improvePrompt) {
            const iprompt = await this.query(Prompts.FFMPEG_IMPROVE_PROMPT.format(prompt, files), true)
            console.log('IMPROVED PROMPT='+ JSON.stringify(iprompt))
            prompt = iprompt
        }
        
        for(let retries = 2; retries > 0; retries--) {
            const ret = await this.query(Prompts.FFMPEG_INSTRUCT.format(prompt, files), true)
            result = this.extractResult(ret)
            if(!result) continue
            const err = this.invalidCommandSyntax(result.commands)
            if(err) {
                result = undefined
                if(!retries) {
                    throw err
                }
            } else {
                break
            }
        }
         
        console.log('GOT INSTRUCTIONS='+ JSON.stringify(result, null, 3))
        for(let i=0; i<improvementsCount; i++) {
            const iret = await this.query(Prompts.FFMPEG_IMPROVE_INSTRUCT.format(result.commands.join("\n"), prompt), true)
            console.log('IMPROVE FEEDBACK='+ iret)
            const improved = this.extractResult(iret)
            if(!improved) continue
            console.log("IMPROVED COMMANDS="+ JSON.stringify(improved, null, 3))
            if(improved && improved.commands && improved.commands.length) {
                const err = this.invalidCommandSyntax(improved.commands)
                if(err) {
                    console.error('IMPROVEMENTS DISCARDED', err)
                    continue
                }
                result = improved
            }
        }

        return result
    }
    async getFFmpegCommands(prompt, files) {
        const masks = this.masker.map(files)
        const maskedPrompt = this.masker.maskText(prompt, masks)
        const filePaths = files.map(f => f.path)
        const plan = await this.iquery(
            maskedPrompt,
            "\n"+ Object.keys(masks).map(m => {
                let info
                files.some(f => {
                    if(f.path == masks[m]) {
                        info = f.info
                        return true
                    }
                })
                if(info) m += ' ('+ info +')'
                return "- "+ m
            }).join("\n")
        )
        for(let i=0; i<plan.tempFiles.length; i++) {
            const file = await this.resolve(plan.tempFiles[i])
            this.masker.set(plan.tempFiles[i], file)
            plan.tempFiles[i] = file
        }
        for(let i=0; i<plan.outputFiles.length; i++) {            
            const file = await this.generateOutputFilename(plan.outputFiles[i], filePaths[i])
            this.masker.set(plan.outputFiles[i], file)
            plan.outputFiles[i] = file
        }
        plan.commands = plan.commands.map(s => this.fixCommandSyntax(s)).map(c => this.masker.unmaskText(c))
        console.log('COMMANDS='+ JSON.stringify(plan, null, 3))
        plan.description = this.skipDescription ? '' : (await this.describe(plan.commands))
        return plan
    }
    async describe(commands, language) {
        return await this.query(Prompts.DESCRIBE_TASK_INSTRUCT.format(commands.join("\n"), language || this.opts.language), true)
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
	parseCommand(cmd) {
		const parsedArguments = []
		let currentArgument = ''
		cmd = cmd.replace(new RegExp('^[a-z\\.]* '), '')
		for (let i = 0; i < cmd.length; i++) {
			const character = cmd.charAt(i)    
			if (character === ' ' && (!currentArgument.startsWith('"') || currentArgument.endsWith('"'))) {
				if (currentArgument.trim() !== '') {
					if(currentArgument.endsWith('"')) {
						currentArgument = currentArgument.substring(1, currentArgument.length - 1)
					}
					parsedArguments.push(currentArgument.trim())
				}
				currentArgument = ''
			} else {
				currentArgument += character
			}
		}    
		if (currentArgument.trim() !== '') {
			currentArgument = currentArgument.trim()
			if(currentArgument.endsWith('"')) {
				currentArgument = currentArgument.substring(1, currentArgument.length - 1)
			}
			parsedArguments.push(currentArgument)
		}    
		return parsedArguments
	}
    async resolve(file) {
        file = this.masker.unquote(file)
        if(file.startsWith('./')) {
            file = file.substr(2)
        }
        if(file.startsWith('/')) {
            file = file.substr(1)
        }
        file = this.masker.unmask(file)
        if(this.opts.cwd && file.indexOf('/') == -1) {
            file = this.opts.cwd +'/'+ file
        }
        return file
    }
    async fixFFmpegCommand(opts) { // {cmd, output}
        let received, output = opts.output.split("\n").map(s => s.trim()).filter(s => s)
        output = this.masker.maskText(output.slice(output.length - 8).join("\n"))
        const cmd = this.masker.maskCommand(opts.cmd)
        for(let retries = 2; retries > 0; retries--) {
            const ret = await this.query(Prompts.FFMPEG_FIX_INSTRUCT.format(cmd, output), false)
            received = this.extractResult(ret)
            if(!received) continue
            const err = this.invalidCommandSyntax(received.commands)
            if(err) {
                received = undefined
                if(!retries) {
                    throw err
                }
            } else {
                break
            }
        }
        return this.masker.unmaskCommand(received.commands.pop())
    }
    getCommandInputFile(cmd) {
        let input = cmd.match(new RegExp('-i (.*) -[A-Za-z0-9](=| )'))
        return this.masker.unquote(input[1].trim())
    }
    getCommandOutputFile(cmd) {
        let parts = this.parseCommand(cmd)
        return this.masker.unquote(parts.pop())
    }
    async fileExists(file) {
        let err
        const stat = await fs.promises.stat(file).catch(e => err = e)
        return !err && stat.size
    }
    async generateOutputFilename(file, referenceFile) {
        let i = 1
        const outputDir = global.forwardSlashes(path.dirname(referenceFile || file))
        const hasTempOutputName = file.split('/').pop().match(new RegExp('(output|te?mp)', 'i'))
        const preferredFileName = outputDir +'/'+ path.basename(referenceFile && hasTempOutputName ? referenceFile : file)
        const outputExt = this.getExt(file, referenceFile)
        const baseLocalOutputfileName = preferredFileName.replace(new RegExp('.vimer[0-9\\-]*.'), '.')
        let localOutputFile = baseLocalOutputfileName.replace(new RegExp('\\.([A-Za-z0-9]{2,5})$'), '.vimer.'+ outputExt)
        while(await this.fileExists(localOutputFile)) {
            i++
            localOutputFile = baseLocalOutputfileName.replace(new RegExp('\\.([A-Za-z0-9]{2,5})$'), '.vimer-'+ i +'.'+ outputExt)
        }
        return localOutputFile
    }
    clear() {
        this.messages = []
        this.masker.clear()
    }
}

module.exports = Midas
