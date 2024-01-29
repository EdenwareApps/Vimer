
class FFmpegBase extends EventEmitter {
	constructor(){
		super()
		this.childs = {}
		this.opts = {}
	}
	parseCommand(cmd) {
		const parsedArguments = []
		let currentArgument = ''
		cmd = cmd.replace(new RegExp('^[a-z\\.]* '), '')
		// Iterate over each character in the input string
		for (let i = 0; i < cmd.length; i++) {
			const character = cmd.charAt(i)    
			// Check if the character is a space and if the current argument is not within quotes
			if (character === ' ' && (!currentArgument.startsWith('"') || currentArgument.endsWith('"'))) {
				// If the current argument is not empty, add it to the list of parsed arguments
				if (currentArgument.trim() !== '') {
					if(currentArgument.endsWith('"')) {
						currentArgument = currentArgument.substring(1, currentArgument.length - 1)
					}
					parsedArguments.push(currentArgument.trim())
				}
				currentArgument = '' // Clear the current argument to start a new one
			} else {
				// Add the character to the current argument
				currentArgument += character
			}
		}    
		// Add the last argument to the list if it exists
		if (currentArgument.trim() !== '') {
			currentArgument = currentArgument.trim()
			if(currentArgument.endsWith('"')) {
				currentArgument = currentArgument.substring(1, currentArgument.length - 1)
			}
			parsedArguments.push(currentArgument)
		}    
		return parsedArguments
	}
}

class FFmpeg extends FFmpegBase {
	constructor(){
		super()
		this.Process = FFmpegProcess
		this.Queue = FFmpegProcessQueue
	}
	async getInfo(file) {
		const proc = new FFmpegProcess(['-i', file], this.opts)
		await proc.start()
		return {
			fps: proc.fps,
			codecs: proc.codecs,
			duration: proc.duration,
			dimensions: proc.dimensions
		}
	}
	abort(pid){
		if(typeof(this.childs[pid]) != 'undefined'){
			const child = this.childs[pid]
			delete this.childs[pid]
			child.abort()
		} else {
			console.log('CANTKILL', pid)
		}
	}
	cleanup(keepIds){
		Object.keys(this.childs).forEach(pid => {
			if(keepIds.includes(pid)){				
				console.log('Cleanup keeping ' + pid)
			} else {
				console.log('Cleanup kill ' + pid)
				this.abort(pid)
			}
		})
	}
}

class FFmpegProcess extends FFmpegBase {
	constructor(cmd, opts) {
        super()
        this.cmd = cmd
		if(!Array.isArray(this.cmd)) {
			this.cmd = this.parseCommand(this.cmd)
		}
		if(!this.cmd.includes('-y')) {
			this.cmd.unshift('-y') // prevent locking on retry
		}
        this.opts = opts
        this.duration = -1
	}
	isMetadata(s){
		return s.indexOf('Stream mapping:') != -1
	}
	start(){
		let hasErr, output = ''
		const maxLogLength = (4 * 1024)
		const checkProgress = s => {			
			if(this.duration == -1) {
				const match = s.match(new RegExp('Duration: *(\\d+:\\d+:\\d+)'))
				if(match) {
					this.duration = this.clockTime(match[1])
				}
			} else {
				const match = s.match(new RegExp('time=(\\d+:\\d+:\\d+)'))
				if (match) {
					const elapsed = this.clockTime(match[1])
					this.progress = elapsed / (this.duration / 100)
					this.progress && this.emit('progress', this.progress)
				}
			}
		}
		const metadataListener = s => {
			checkProgress(s)
			if(!this.dimensions) {
				let match = s.match(new RegExp('[0-9]{2,5}x[0-9]{2,5}'))
				if(match && match.length) {
					this.dimensions = match[0]
				}
			}
			if(!this.fps) {
				let match = s.match(new RegExp('[0-9\\.]+ ?fps'))
				if(match && match.length) {
					this.fps = parseFloat(match[0])
				}
			}
			if(!this.codecs) {
				let rp = ': ([^,\r\n]+)'
				let video = output.match(new RegExp('Video' + rp))
				let audio = output.match(new RegExp('Audio' + rp))
				let unknown = output.match(new RegExp('Unknown' + rp))
				video = Array.isArray(video) ? video[1] : (Array.isArray(unknown) ? 'unknown' : '')
				audio = Array.isArray(audio) ? audio[1] : ''
				if(audio || video) {
					this.codecs = {audio, video}
				}
			}
			this.emit('metadata', output)
		}
		const dataListener = s => {
			s = String(s)
			output += s
			console.log(s)
			checkProgress(s)
			if(output.length > maxLogLength){
				output = output.substr(-maxLogLength)
			}       
		}
		return new Promise((resolve, reject) => {
			api.ffmpeg.exec(this.cmd, {
				metadata: metadataListener,
				data: dataListener,
				error: err => {
					hasErr = err
					console.log('FFEXEC ERR', this.cmd, err)
					output += "\n"+ err +"\n"
				},
				finish: () => {
					console.log('FFEXEC DONE', this.cmd.join(' '))
					this.emit('progress', 100)
					this.emit('end', output)
					if(this.aborted) return reject('Aborted')
					if(hasErr) return reject(hasErr)
					resolve(output)
				}
			})
		})
	}
	clockTime(str) {
		let cs = str.split('.'), p = cs[0].split(':'), s = 0, m = 1
		while (p.length > 0) {
			s += m * parseInt(p.pop(), 10);
			m *= 60;
		}    
		if(cs.length > 1 && cs[1].length >= 2){
			s += parseInt(cs[1].substr(0, 2)) / 100
		}
		return s
	}
	abort(){
		this.aborted = true
        this.emit('abort')
		this.child.kill('SIGINT')
        this.removeAllListeners()
	}
}

class FFmpegProcessQueue extends FFmpegBase {
	constructor(cmds, opts={}) {
        super()
        this.cmds = cmds
		this.processes = []
		this.progresses = []
		this.outputs = []
		Object.assign(this.opts, opts)
	}
	async run(cmd, i, maxAutofixAmount=4) {
		let hasErr
		this.outputs[i] = ''
		this.progresses[i] = 0
		this.processes[i] = new FFmpegProcess(cmd, this.opts)
		this.processes[i].on('error', err => {
			this.listenerCount('error') && this.emit('error', err, cmd)
			hasErr = String(err.message || err)
		})
		this.processes[i].on('progress', p => {
			this.progresses[i] = p
			this.emitProgress()
		})
		this.processes[i].on('end', output => {
			this.outputs[i] = output
		})
		await this.processes[i].start()
		if(this.opts.validator) {
			let err
			const ret = await this.opts.validator(cmd, this.outputs[i]).catch(e => err = e)
			if(err) throw err
			if(ret != true) {
				maxAutofixAmount--
				if(maxAutofixAmount && typeof(ret) == 'string') {
					return await this.run(ret, i, maxAutofixAmount)
				} else {
					let err = this.outputs[i].split("\n")
					err = err.slice(Math.max(0, err.length - 8)).join("\n")
					if(hasErr) err += "\n"+ hasErr
					throw 'Command has failed: '+ err
				}
			}
		}
		return this.outputs[i]
	}
	async start(){		
		let err
		const ret = await this.__start().catch(e => err = e)
		setTimeout(() => this.emit('end'), 0)
		if(err) throw err
		return ret
	}
	async __start(){
		let i = 0
		for(const cmd of this.cmds) {
			await this.run(cmd, i)
			i++
		}
		setTimeout(() => this.emit('end'), 0)
		return true
	}
	emitProgress() {
		let sum = 0
		this.cmds.forEach((cmd, i) => {
			if(this.progresses[i]) {
				sum += this.progresses[i]
			}
		})
		const progress = parseInt(sum / this.cmds.length)
		if(progress != this.progress) {
			this.progress = progress
			this.progress && this.emit('progress', this.progress)
		}
	}
	abort(){
		this.processes.forEach(p => p.abort())
        this.emit('abort')
        this.removeAllListeners()
	}
}

ffmpeg = new FFmpeg()
