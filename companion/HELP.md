# GrandMA3 Connection

Connection to control your grandMA3 Software via OSC.

# Installation

1. In configuration tab specify the "Console IP", "Console OSC Port" and "Prefix" you want to send on.
2. Configure OSC (Settings -> In&Out) with the same settings as set in the configuration tab. (Same IP, Port & Prefix). Make sure to check "Receive Command" and "Receive", if not checked, the plugin will not work. [Tutorial](https://help2.malighting.com/Page/grandMA3/remote_inputs_osc/en/1.9)
3. Create a button, select action and start!

# Feedback (sequence states)

Tested live on grandMA3 onPC 2.5.1.1, 2.4.2 and 2.3.2. The object address layout is read from the console at connect (or learned from the first sequence message), and the older 2.3/2.4 message format (no `;` between sequence and cue, no name on Off/Pause/Flash/fader messages, Toggle reported without the following Off) is detected and handled automatically.

grandMA3 sends OSC feedback when playback objects are operated. The module uses it to show whether a sequence is running, its current cue, its master fader level and held Flash/Temp/Black/Swap.

**Setup in grandMA3** (Menu → In & Out → OSC), on the OSC entry Companion sends to (or a second entry):

- **Send = Yes**, Destination IP = the Companion machine, Port = the module's **grandMA3 Output Port** (default 8082)
- **Receive Command = Yes** for the Lua state queries (see below)
- If the entry has a **Prefix**, enter it as **grandMA3 Output Prefix**
- **grandMA3 and Companion on the same computer:** grandMA3 binds the port of every OSC entry itself (also send-only entries) when OSC starts, and sends the feedback to that same port number, so no other program on that computer can receive it. Feedback therefore needs Companion and grandMA3 on **different machines** (the usual console / onPC + Companion setup). On one machine it only works while the entry's port was changed after grandMA3 started OSC, until the next OSC or grandMA3 restart.
- The OSC **Interface** in grandMA3 (Menu → In & Out → OSC) must be a network interface that exists on the machine; with a stale "preferred IP" grandMA3 may bind no OSC ports at all after an OSC restart.

**Setup in Companion:** tick **Enable feedback from grandMA3** in the connection settings.

## Feedbacks

| Feedback                             | True when                                                                         |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Sequence: running                    | the sequence is known to run (option: also while Flash/Temp is held)              |
| Sequence: state known                | the module knows whether the sequence runs — invert it to style unknown sequences |
| Sequence: current cue                | the current cue compares to a number (=, ≠, >, ≥, <, ≤; numeric, so 4.5 > 4)      |
| Sequence: master fader level         | the master fader compares to a level in %                                         |
| Sequence: Flash/Temp/Black/Swap held | that function is currently held                                                   |
| Sequence: paused                     | a Pause was seen after a known start                                              |

Every feedback picks its sequence with two dropdowns: first the **DataPool** (`125: Show`), then the **Sequence** of that DataPool (`212: FR P1`). The lists come from grandMA3 (Lua sync) and update when DataPools or sequences are added or renamed. Every dropdown also accepts a typed **number or name** (case-insensitive, quotes optional) or a variable. For a DataPool the module does not know yet (or without Lua queries), a text field **Sequence (number or name)** is shown instead. Names are also learned from every feedback message, so renames are picked up; without Lua queries DataPools must be given as numbers. If a name exists twice in a DataPool, the lowest number is used. An unknown name triggers at most one name refresh per minute. **Learn** selects the last sequence operated in grandMA3.

## Variables

- Per sequence (created the first time the sequence is seen): `seq_<datapool>_<sequence>_running` (on/off/unknown), `_cue`, `_cue_name`, `_name`, `_fader` — e.g. `$(grandma3:seq_1_5_cue)`
- Last event, useful for triggers: `last_function`, `last_object`, `last_address`, `last_seq`, `last_seq_name`, `last_cue`, `last_cue_name`
- `feedback_last_rx` (seconds since the last message), `lua_query_status`

## Lua state queries (read only)

grandMA3 only sends _events_, and some state changes send none at all (a fader AutoStart/AutoStop, a sequence switched off by being overridden). To stay correct, the module reads states with small **read-only** Lua commands sent over OSC (`Lua "CompanionQ.sync(8082,3)"`):

- on connect: the address layout of the running firmware and the state of every running sequence
- after a fader starts or stops a sequence: that sequence
- after the **Executor Button** action: the sequence on that executor
- on the **Feedback: resync states from grandMA3** action

Nothing is installed or stored in the show. On connect the module defines a temporary helper table `CompanionQ` in grandMA3's Lua memory (gone after an MA restart; the module re-sends it automatically). **Each query is visible in the grandMA3 command line**, which is why the module never polls. Queries need **Receive Command = Yes**, and the OSC entry's Destination IP must be the Companion machine or a subnet broadcast address (grandMA3's Lua socket cannot send to `255.255.255.255`). Otherwise the module falls back to events only and shows a status message; automatic retries back off (1 min, 5 min, 25 min) and then stop until you resync, so the command line is not flooded. Untick **Read sequence states with Lua queries** to disable them.

## Limits

- Pause is reported by grandMA3 only as a toggle and cannot be read via Lua, so "paused" can be unknown.
- Without Lua queries, sequences are "unknown" until grandMA3 reports something for them, and fader AutoStart/AutoStop is assumed (option).
- grandMA3 sends no feedback for actions it received as direct OSC executor/object input, including this module's own **Executor Button** action (`/PageX/KeyY`). With Lua queries enabled, the module therefore reads the state of the executor's sequence after each press (one short read-only query per press). Without Lua queries such presses are not followed; use **Run Command** (e.g. `Go+ Page 1.201`) instead.

# Call Object by DataPool/Name

The **Call Object by DataPool/Name** action runs a function on any grandMA3 object:

1. **DataPool**: pick one (`125: Show`) or type a number or name
2. **Object type**: Sequence, Group, Preset, Macro, Plugin, Quickey, MAtricks, Timer, World, Filter, Layout, Timecode or Page
3. **Object**: pick it from the list of that type in the chosen DataPool (`212: FR P1`, presets as `4.1: White`), or type a number or name
4. **Function**: Go+, Go-, Top, On, Off, Toggle, Pause, Kill, Flash On/Off, Temp On/Off, Call, Select, Load, or type another command keyword (letters, + and - only)

It sends a command such as `Go+ DataPool 125 Sequence "FR P1"`: numbers as they are, names in quotes (grandMA3 resolves them). The lists come from grandMA3 when feedback with Lua queries is on; without them the dropdowns stay empty and you type the number or name into them, so the action also works with feedback switched off. Names containing `"` cannot be sent. **Learn** selects the last sequence operated in grandMA3.

Presets for every object type are in the presets panel under Sequences, Groups, Presets, Macros, Plugins, Quickeys, MAtricks, Worlds and Timers; they use object 1 in DataPool 1, re-pick the object after dragging one onto a button.

# Example configuration

I do provide a custom-made Companion Layout for a StreamDeck XL, that is fully compatible with this plugin. You can download it from [here](https://github.com/bitfocus/companion-module-malighting-grandma3/tree/main/configuration-examples).
It comes with a LUA plugin, that you can import into your grandMA3 onPC Software, that automatically creates an OSC entry, and the corresponding Quickeys needed for my custom Companion Layout.

It also comes with a page named "Numpad" that allows you to use it with the Software VICREO-Listener which can be downloaded on the plugin page after importing the Layout.
This page is a virtual numpad that allows you to use the grandMA3 Software without a physical keyboard.

# Functions

- Select Sequences
- Select MAtricks
- Call Macros
- Call Plugins
- Select Groups
- Run Quick Keys
- At Menu
- Run Commands
- Toggle Executor Buttons (100/200/300/400)
- Call Object by DataPool/Name (any object type, picked from dropdowns)
- Feedback: sequence running / cue / fader / held / paused, resync, manual state override
