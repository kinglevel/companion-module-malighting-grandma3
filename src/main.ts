import {
	InstanceBase,
	runEntrypoint,
	InstanceStatus,
	type OSCSomeArguments,
	type SharedUdpSocket,
	type SomeCompanionConfigField,
} from '@companion-module/base'
import type { RemoteInfo } from 'node:dgram'
import { CONFIG_DEFAULTS, GetConfigFields, type ModuleConfig } from './config.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import { UpdatePresets } from './presets.js'
import { decodePacket } from './osc/codec.js'
import { FeedbackEngine } from './feedback/engine.js'

const BIND_RETRY_MS = 5000
const SILENCE_HINT_MS = 10_000

type SocketState = 'off' | 'binding' | 'bound' | 'error'

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()
	engine: FeedbackEngine | undefined
	#socket: SharedUdpSocket | undefined
	#socketState: SocketState = 'off'
	#socketError = ''
	#bindRetry: NodeJS.Timeout | undefined
	#silenceTimer: NodeJS.Timeout | undefined
	#silenceElapsed = false
	#lastStatus = ''
	readonly #rejectedSenders = new Set<string>()

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = withDefaults(config)
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.#startFeedback()
	}

	// When module gets deleted
	async destroy(): Promise<void> {
		this.#stopFeedback()
		this.log('debug', 'Module destroyed')
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = withDefaults(config)
		this.#stopFeedback()
		this.updateActions()
		this.updateFeedbacks()
		this.updatePresets()
		this.#startFeedback()
	}

	// Return config fields for web config
	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	updateActions(): void {
		UpdateActions(this)
	}

	updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	updatePresets(): void {
		UpdatePresets(this)
	}

	/** Send an OSC message to grandMA3, honouring the input prefix. */
	sendOsc(path: string, args: OSCSomeArguments): void {
		const fullPath = this.config.inputPrefix ? '/' + this.config.inputPrefix + path : path
		this.oscSend(this.config.host, Number(this.config.port), fullPath, args)
	}

	/** Run a command-line command on grandMA3 via `/cmd`. */
	sendCommand(command: string): void {
		this.sendOsc('/cmd', [{ type: 's', value: command }])
	}

	// ------------------------------------------------------------------ feedback lifecycle

	#startFeedback(): void {
		this.#rejectedSenders.clear()
		if (!this.config.feedbackEnabled) {
			this.setVariableDefinitions([])
			this.#refreshStatus()
			return
		}
		const port = Number(this.config.feedbackPort)
		if (!Number.isInteger(port) || port < 1 || port > 65535) {
			this.#socketState = 'error'
			this.#socketError = 'Invalid grandMA3 Output Port'
			this.#refreshStatus()
			return
		}

		this.engine = new FeedbackEngine(
			{
				log: (level, msg) => this.log(level, msg),
				sendCommand: (c) => this.sendCommand(c),
				checkFeedbacksById: (...ids) => this.checkFeedbacksById(...ids),
				setVariableDefinitions: (defs) => this.setVariableDefinitions(defs),
				setVariableValues: (values) => this.setVariableValues(values),
				statusChanged: () => this.#refreshStatus(),
				// New/renamed DataPools or sequences: refresh the DataPool → Sequence dropdown choices
				catalogChanged: () => {
					this.updateFeedbacks()
					this.updateActions()
				},
			},
			{
				outputPrefix: this.config.outputPrefix ?? '',
				luaQueries: this.config.luaQueries,
				assumeAutoStart: this.config.assumeAutoStart,
				debug: this.config.feedbackDebug,
				feedbackPort: port,
			},
		)
		// Feedback instances register themselves in their callbacks
		this.checkFeedbacks()
		this.#bind(port)
	}

	#bind(port: number): void {
		this.#socketState = 'binding'
		this.#refreshStatus()
		const socket = this.createSharedUdpSocket('udp4', (msg, rinfo) => this.#onPacket(msg, rinfo))
		this.#socket = socket
		socket.on('error', (err: Error) => {
			if (this.#socket !== socket) return
			const message = /EADDRINUSE/i.test(err.message)
				? `Port ${port} is in use. If grandMA3 runs on this computer it binds the ports of its own OSC entries; feedback needs grandMA3 and Companion on different machines (see help).`
				: `Feedback listener error: ${err.message}`
			// Retries every 5 s: only log when the error changes
			if (message !== this.#socketError) this.log('error', message)
			this.#socketState = 'error'
			this.#socketError = message
			this.#refreshStatus()
			this.#closeSocket()
			this.#bindRetry ??= setTimeout(() => {
				this.#bindRetry = undefined
				if (this.config.feedbackEnabled && this.engine) this.#bind(port)
			}, BIND_RETRY_MS)
		})
		socket.bind(port, undefined, () => {
			if (this.#socket !== socket) {
				// Closed (config change / destroy) while the bind was still pending: release it now,
				// closing a socket in the binding state is not possible
				try {
					socket.close()
				} catch {
					// ignore
				}
				return
			}
			this.#socketState = 'bound'
			this.log('info', `Listening for grandMA3 feedback on port ${port}`)
			this.#silenceElapsed = false
			if (this.#silenceTimer) clearTimeout(this.#silenceTimer)
			this.#silenceTimer = setTimeout(() => {
				this.#silenceElapsed = true
				this.#refreshStatus()
			}, SILENCE_HINT_MS)
			this.engine?.startQueries()
			this.#refreshStatus()
		})
	}

	#onPacket(msg: Buffer, rinfo: RemoteInfo): void {
		if (!this.engine) return
		if (!this.config.feedbackAnySource && !sameHost(rinfo.address, this.config.host)) {
			if (!this.#rejectedSenders.has(rinfo.address) && this.#rejectedSenders.size < 32) {
				this.#rejectedSenders.add(rinfo.address)
				this.log(
					'warn',
					`Ignoring feedback from ${rinfo.address} (expected ${this.config.host}; enable "Accept feedback from any IP address" if MA sends from another interface)`,
				)
			}
			return
		}
		try {
			this.engine.handleMessages(decodePacket(msg))
		} catch (e) {
			this.log('debug', `Feedback handling failed: ${e instanceof Error ? e.message : String(e)}`)
		}
	}

	#closeSocket(): void {
		const s = this.#socket
		this.#socket = undefined
		if (!s) return
		s.removeAllListeners()
		s.on('error', () => {})
		try {
			s.close()
		} catch {
			// already closed
		}
	}

	#stopFeedback(): void {
		if (this.#bindRetry) clearTimeout(this.#bindRetry)
		if (this.#silenceTimer) clearTimeout(this.#silenceTimer)
		this.#bindRetry = undefined
		this.#silenceTimer = undefined
		this.#closeSocket()
		this.engine?.destroy()
		this.engine = undefined
		this.#socketState = 'off'
		this.#socketError = ''
	}

	// ------------------------------------------------------------------ status

	#refreshStatus(): void {
		const [status, message] = this.#computeStatus()
		const key = `${status}|${message ?? ''}`
		if (key === this.#lastStatus) return
		this.#lastStatus = key
		this.updateStatus(status, message)
	}

	#computeStatus(): [InstanceStatus, string | null] {
		if (!this.config.feedbackEnabled) return [InstanceStatus.Ok, null]
		if (this.#socketState === 'error') {
			return [
				this.#socketError.startsWith('Invalid') ? InstanceStatus.BadConfig : InstanceStatus.ConnectionFailure,
				this.#socketError,
			]
		}
		if (this.#socketState !== 'bound' || !this.engine) return [InstanceStatus.Connecting, null]

		const q = this.engine.queryStatus
		const received = this.engine.everReceived
		if (q === 'ready') return [InstanceStatus.Ok, null]
		if (q === 'unavailable' && received) {
			return [
				InstanceStatus.Ok,
				"Lua state queries not answered: set 'Receive Command = Yes' on the grandMA3 OSC entry and use this machine's IP (not 255.255.255.255) as its Destination IP. States may be incomplete.",
			]
		}
		if (q === 'disabled' && received) return [InstanceStatus.Ok, null]
		if (this.#silenceElapsed && !received) {
			return [
				InstanceStatus.Connecting,
				'No answer from grandMA3: check Console IP, Input Port/Prefix and that the OSC entry sends to this machine on the Output Port.',
			]
		}
		return [
			InstanceStatus.Connecting,
			q === 'disabled' ? 'Waiting for feedback from grandMA3' : 'Syncing with grandMA3…',
		]
	}
}

function withDefaults(config: ModuleConfig): ModuleConfig {
	return { ...CONFIG_DEFAULTS, ...config }
}

function normaliseIp(ip: string): string {
	const v = ip.trim().toLowerCase()
	if (v.startsWith('::ffff:')) return v.slice(7)
	if (v === '::1' || v === 'localhost') return '127.0.0.1'
	return v
}

function sameHost(sender: string, configured: string): boolean {
	return normaliseIp(sender) === normaliseIp(configured ?? '')
}

runEntrypoint(ModuleInstance, UpgradeScripts)
