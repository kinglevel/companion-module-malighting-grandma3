import type { ModuleInstance } from './main.js'
import type { Tri } from './ma/sequences.js'
import { buildPickerFields, resolvePicker, SEQUENCE_PICKER } from './picker/objectPicker.js'

export function UpdateActions(self: ModuleInstance): void {
	// Arguments stay loosely typed: the executor action sends a `T` (true) argument, which Companion's
	// OSC sender supports but its type definitions do not list
	const sendOscMessage = (path: string, args: any) => {
		self.log('debug', `OSC: Sending to ${self.config.host}:${self.config.port} ${path} ${JSON.stringify(args)}`)
		self.sendOsc(path, args)
	}

	self.setActionDefinitions({
		quickey: {
			name: 'Select Quickey via number',
			options: [
				{
					type: 'number',
					label: 'Quickey Number',
					id: 'quickey',
					step: 1,
					min: 1,
					max: 9999,
					default: 1,
				},
			],
			callback: async (event) => {
				if ((event.options.quickey! as number) % 1 !== 0) {
					self.log('error', `Quickey: Invalid number`)
					return
				}
				const quickey = event.options.quickey

				self.log('debug', `Quickey: Trigger by number ${quickey}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Quickey ' + quickey,
					},
				])
			},
		},
		quickey_name: {
			name: 'Select Quickey via name',
			options: [
				{
					type: 'textinput',
					label: 'Quickey Name',
					id: 'quickey',
					default: 'OOPS',
				},
			],
			callback: async (event) => {
				const quickey = event.options.quickey

				self.log('debug', `Quickey: Trigger by name ${quickey}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Quickey "' + quickey + '"',
					},
				])
			},
		},
		group: {
			name: 'Select Group via number',
			options: [
				{
					type: 'number',
					label: 'Group Number',
					id: 'group',
					min: 1,
					max: 9999,
					default: 1,
				},
			],
			callback: async (event) => {
				if ((event.options.group! as number) % 1 !== 0) {
					self.log('error', `Group: Invalid number`)
					return
				}
				const group = event.options.group

				self.log('debug', `Group: Select by number ${group}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'SelectFixtures Group ' + group,
					},
				])
			},
		},
		group_name: {
			name: 'Select Group via name',
			options: [
				{
					type: 'textinput',
					label: 'Group Name',
					id: 'group',
					default: 'Front Lights',
				},
			],
			callback: async (event) => {
				const group = event.options.group

				self.log('debug', `Group: Select by name ${group}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'SelectFixtures Group "' + group + '"',
					},
				])
			},
		},
		matrick: {
			name: 'Select MAtrick via number',
			options: [
				{
					type: 'number',
					label: 'MAtrick Number',
					id: 'matrick',
					min: 1,
					max: 9999,
					default: 1,
				},
			],
			callback: async (event) => {
				if ((event.options.matrick! as number) % 1 !== 0) {
					self.log('error', `MAtrick: Invalid number`)
					return
				}
				const matrick = event.options.matrick

				self.log('debug', `MAtrick: Select by number ${matrick}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'SelectFixtures MAtricks ' + matrick,
					},
				])
			},
		},
		matrick_name: {
			name: 'Select MAtrick via name',
			options: [
				{
					type: 'textinput',
					label: 'MAtrick Name',
					id: 'matrick',
					default: 'Odd',
				},
			],
			callback: async (event) => {
				const matrick = event.options.matrick

				self.log('debug', `MAtrick: Select by name ${matrick}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'SelectFixtures MAtricks "' + matrick + '"',
					},
				])
			},
		},
		sequence: {
			name: 'Select Sequence via number',
			options: [
				{
					type: 'number',
					label: 'Sequence Number via number',
					id: 'sequence',
					min: 1,
					max: 9999,
					default: 1,
				},
			],
			callback: async (event) => {
				if ((event.options.sequence! as number) % 1 !== 0) {
					self.log('error', `Sequence: Invalid number`)
					return
				}
				const sequence = event.options.sequence

				self.log('debug', `Sequence: Select by number ${sequence}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Select Sequence ' + sequence,
					},
				])
			},
		},
		sequence_name: {
			name: 'Select Sequence via name',
			options: [
				{
					type: 'textinput',
					label: 'Sequence Name',
					id: 'sequence',
					default: 'Random Strobe',
				},
			],
			callback: async (event) => {
				const sequence = event.options.sequence

				self.log('debug', `Sequence: Select by name ${sequence}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Select Sequence "' + sequence + '"',
					},
				])
			},
		},
		plugin: {
			name: 'Call Plugin via number',
			options: [
				{
					type: 'number',
					label: 'Plugin Number',
					id: 'plugin',
					min: 1,
					max: 9999,
					default: 1,
				},
			],
			callback: async (event) => {
				if ((event.options.plugin! as number) % 1 !== 0) {
					self.log('error', `Plugin: Invalid number`)
					return
				}
				const plugin = event.options.plugin

				self.log('debug', `Plugin: Call by number ${plugin}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Call Plugin ' + plugin,
					},
				])
			},
		},
		plugin_name: {
			name: 'Call Plugin via name',
			options: [
				{
					type: 'textinput',
					label: 'Plugin Name',
					id: 'plugin',
					default: 'Cool Plugin 123',
				},
			],
			callback: async (event) => {
				const plugin = event.options.plugin

				self.log('debug', `Plugin: Call by name ${plugin}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Call Plugin "' + plugin + '"',
					},
				])
			},
		},
		macro: {
			name: 'Call Macro via number',
			options: [
				{
					type: 'number',
					label: 'Macro Number',
					id: 'macro',
					min: 1,
					max: 9999,
					default: 1,
				},
			],
			callback: async (event) => {
				if ((event.options.macro! as number) % 1 !== 0) {
					self.log('error', `Macro: Invalid number`)
					return
				}
				const macro = event.options.macro

				self.log('debug', `Macro: Call by number ${macro}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Go+ Macro ' + macro,
					},
				])
			},
		},
		macro_name: {
			name: 'Call Macro via name',
			options: [
				{
					type: 'textinput',
					label: 'Macro Name',
					id: 'macro',
					default: 'Cool Macro 456',
				},
			],
			callback: async (event) => {
				const macro = event.options.macro

				self.log('debug', `Macro: Call by name ${macro}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: 'Go+ Macro "' + macro + '"',
					},
				])
			},
		},
		atmenu: {
			name: 'At Menu',
			options: [
				{
					id: 'atmenu',
					type: 'dropdown',
					label: 'At Menu Item',
					default: 'At Full',
					choices: [
						{
							id: 'At Full',
							label: 'Full',
						},
						{
							id: 'At Zero',
							label: 'Zero',
						},
						{
							id: 'At Default',
							label: 'Default',
						},
						{
							id: 'Cut Programmer',
							label: 'Cut Programmer',
						},
						{
							id: 'At Normal',
							label: 'Normal',
						},
						{
							id: 'Copy Programmer',
							label: 'Copy Programmer',
						},
						{
							id: 'On Selection',
							label: 'On',
						},
						{
							id: 'Paste Programmer',
							label: 'Paste Programmer',
						},
						{
							id: 'Off Selection',
							label: 'Off',
						},
						{
							id: 'At Release',
							label: 'Release',
						},
						{
							id: 'Delete Programmer',
							label: 'Delete Steps',
						},
						{
							id: 'At Remove',
							label: 'Remove',
						},
					],
				},
			],
			callback: async (event) => {
				const command = event.options.atmenu

				self.log('debug', `Menu: Execute ${command}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: command,
					},
				])
			},
		},
		command: {
			name: 'Run Command',
			options: [
				{
					type: 'textinput',
					label: 'Command',
					id: 'command',
					default: 'SelectFixtures Group 1',
					useVariables: true,
				},
			],
			callback: async (event) => {
				let command = event.options.command

				if (command === undefined) {
					self.log('error', `Command: Invalid command`)
					return
				}

				command = await self.parseVariablesInString(command.toString())

				self.log('debug', `Command: Execute ${command}`)

				sendOscMessage('/cmd', [
					{
						type: 's',
						value: command,
					},
				])
			},
		},
		exec_button: {
			name: 'Executor Button',
			options: [
				{
					id: 'page',
					type: 'number',
					label: 'Page',
					min: 1,
					max: 9999,
					default: 1,
					isVisibleExpression: '$(options:current_page)==false',
				},
				{
					id: 'current_page',
					type: 'checkbox',
					label: 'Use current page',
					default: false,
				},
				{
					id: 'button_number',
					type: 'number',
					label: 'Button',
					min: 1,
					max: 490,
					default: 201,
				},
				{
					id: 'button_state',
					type: 'dropdown',
					label: 'Button State',
					default: 'push',
					choices: [
						{
							id: 'push',
							label: 'Push',
						},
						{
							id: 'release',
							label: 'Release',
						},
					],
				},
			],
			callback: async (event) => {
				const button_number = event.options.button_number
				const button_state = event.options.button_state
				const use_current_page = event.options.current_page
				const page = event.options.page

				self.log('debug', `Executor: Button ${button_number} ${button_state} on page ${page}`)

				const pageVal = use_current_page ? '' : page

				// MA sends no feedback for direct executor input: read the executor's sequence state instead
				// (debounced, so a press + release becomes one read-only query)
				self.engine?.checkExecutor(use_current_page ? 0 : Number(page), Number(button_number))

				if (button_state === 'push') {
					sendOscMessage('/Page' + pageVal + '/Key' + button_number, [
						{
							type: 'T',
						},
					])
				} else {
					sendOscMessage('/Page' + pageVal + '/Key' + button_number, [
						{
							type: 'i',
							value: 0,
						},
					])
				}
			},
		},
		feedback_resync: {
			name: 'Feedback: resync states from grandMA3',
			description:
				'Reads the running state of every sequence with a read-only Lua query (needs "Receive Command" on the grandMA3 OSC entry). Visible once in the grandMA3 command line.',
			options: [],
			callback: async () => {
				if (!self.engine) {
					self.log('warn', 'Resync: feedback is disabled in the connection settings')
					return
				}
				self.engine.resync()
			},
		},
		set_sequence_state: {
			name: 'Feedback: set sequence state manually',
			description:
				'Overrides what the module believes about a sequence (e.g. on a startup trigger). The next message from grandMA3 for that sequence replaces it.',
			options: [
				...buildPickerFields(SEQUENCE_PICKER, self.engine?.catalog),
				{
					type: 'dropdown',
					label: 'State',
					id: 'state',
					default: 'off',
					choices: [
						{ id: 'on', label: 'Running' },
						{ id: 'off', label: 'Off' },
						{ id: 'unknown', label: 'Unknown' },
					],
				},
				{
					type: 'textinput',
					label: 'Cue Number (optional, when running)',
					id: 'cue',
					default: '',
					useVariables: true,
					isVisibleExpression: "$(options:state) == 'on'",
				},
			],
			callback: async (event) => {
				if (!self.engine) {
					self.log('warn', 'Set sequence state: feedback is disabled in the connection settings')
					return
				}
				const { result: resolved } = await resolvePicker(SEQUENCE_PICKER, event.options, self.engine, async (t) =>
					self.parseVariablesInString(t),
				)
				if (!resolved.ok) {
					self.log('error', `Set sequence state: cannot resolve the sequence (${resolved.reason})`)
					return
				}
				const { dataPool: dp, sequence: seq } = resolved.ref
				const cue = (await self.parseVariablesInString(String(event.options.cue ?? ''))).trim()
				const state = String(event.options.state) as Tri
				if (state !== 'on' && state !== 'off' && state !== 'unknown') return
				self.engine.setManual(dp, seq, state, cue || undefined)
			},
		},
	})
}
