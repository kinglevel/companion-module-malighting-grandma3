import { Regex, type SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
	host: string
	port: number
	inputPrefix: string
	outputPrefix: string
	feedbackPort: string
	/** Listen for grandMA3's OSC playback feedback */
	feedbackEnabled: boolean
	/** Read sequence states with read-only Lua queries (needs "Receive Command" on the OSC entry) */
	luaQueries: boolean
	/** Fallback when Lua queries are unavailable: fader up from 0 = start, fader to 0 = stop */
	assumeAutoStart: boolean
	/** Accept feedback packets from any sender instead of only the console IP */
	feedbackAnySource: boolean
	/** Log every decoded feedback message (debug level) */
	feedbackDebug: boolean
}

export const CONFIG_DEFAULTS = {
	feedbackEnabled: true,
	luaQueries: true,
	assumeAutoStart: true,
	feedbackAnySource: false,
	feedbackDebug: false,
} as const

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			width: 12,
			label: 'Information',
			value:
				'This module uses OSC in grandMA3. For more information please visit <a href="https://help.malighting.com/grandMA3/2.3/HTML/remote_inputs_osc.html" target="_blank">this link</a>.<br>' +
				'<br>Here is an short explanaiton for the configuration fields below:' +
				'<br>- gMA3 Input Port / Prefix = Companion -> gMA3' +
				'<br>- gMA3 Output Port / Prefix = gMA3 -> Companion<br>' +
				'<br><b>Important:</b> Prefixes are only being considered if they are set, if not, any message gets through.',
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'grandMA3 Console IP',
			width: 6,
			regex: Regex.IP,
			default: '127.0.0.1',
		},
		{
			type: 'textinput',
			id: 'port',
			label: 'grandMA3 Input Port',
			width: 6,
			regex: Regex.PORT,
			default: '8081',
		},
		{
			type: 'textinput',
			id: 'inputPrefix',
			label: 'grandMA3 Input Prefix',
			width: 6,
			default: '',
		},
		{
			type: 'static-text',
			id: 'feedbackInfo',
			width: 12,
			label: 'Feedback',
			value:
				'To receive feedback, set the grandMA3 OSC entry to <b>Send = Yes</b> with Destination IP = this Companion machine and Port = the Output Port below. ' +
				'Lua state queries additionally need <b>Receive Command = Yes</b>. ' +
				'They only read states, but each query is visible in the command line of grandMA3.',
		},
		{
			type: 'checkbox',
			id: 'feedbackEnabled',
			label: 'Enable feedback from grandMA3',
			width: 6,
			default: CONFIG_DEFAULTS.feedbackEnabled,
		},
		{
			type: 'textinput',
			id: 'feedbackPort',
			label: 'grandMA3 Output Port',
			width: 6,
			default: '8082',
			regex: Regex.PORT,
			isVisibleExpression: '$(options:feedbackEnabled)',
		},
		{
			type: 'textinput',
			id: 'outputPrefix',
			label: 'grandMA3 Output Prefix',
			width: 6,
			default: '',
			isVisibleExpression: '$(options:feedbackEnabled)',
		},
		{
			type: 'checkbox',
			id: 'luaQueries',
			label: 'Read sequence states with Lua queries (read only)',
			width: 6,
			default: CONFIG_DEFAULTS.luaQueries,
			isVisibleExpression: '$(options:feedbackEnabled)',
		},
		{
			type: 'checkbox',
			id: 'assumeAutoStart',
			label: 'Fader 0 → up starts, fader → 0 stops (fallback without Lua)',
			tooltip:
				'grandMA3 sends no event when a fader AutoStarts/AutoStops a sequence. ' +
				'With Lua queries the real state is read; without them this assumption is used.',
			width: 6,
			default: CONFIG_DEFAULTS.assumeAutoStart,
			isVisibleExpression: '$(options:feedbackEnabled)',
		},
		{
			type: 'checkbox',
			id: 'feedbackAnySource',
			label: 'Accept feedback from any IP address',
			tooltip: 'By default only packets from the console IP are accepted.',
			width: 6,
			default: CONFIG_DEFAULTS.feedbackAnySource,
			isVisibleExpression: '$(options:feedbackEnabled)',
		},
		{
			type: 'checkbox',
			id: 'feedbackDebug',
			label: 'Debug log every feedback message',
			width: 6,
			default: CONFIG_DEFAULTS.feedbackDebug,
			isVisibleExpression: '$(options:feedbackEnabled)',
		},
	]
}
