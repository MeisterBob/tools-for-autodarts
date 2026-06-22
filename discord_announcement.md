# :dart: Tools for Autodarts v2.3.0 :dart:

### :rotating_light: Important — please update before June 28
Autodarts is migrating its login system and the old auth server **shuts down on June 28, 2026**. This release updates how the extension captures your login token so features that talk to Autodarts (like Quick Correction) keep working afterwards. **Update before June 28 to avoid interruptions** — no action needed beyond updating.

### :new: What's new

:checkered_flag: **Checkout Guide**
Displays the suggested checkout darts right inside each player's score box, so everyone can see the recommended finish at a glance. Enable it in the Matches tab.

:loud_sound: **New `opponent_throw` Sound FX trigger**
Plays a sound whenever a remote opponent throws a dart — handy throw feedback when you're playing online and not staring at the screen. Your own throws are skipped (so it won't double up with your board's throw sound), and bots keep using `bot_throw`.
_(Requested in #170)_

### :wrench: Fixes
- Updated authentication for the Autodarts OAuth 2.0 migration (see above)
- Fixed the Gotcha Helper position after a recent Autodarts update

### :handshake: Community
Thanks to **@MeisterBob** for contributing the Checkout Guide and the Gotcha Helper fix! :tada:

---

Please report any bugs in
:flag_de: https://discord.com/channels/802528604067201055/1255293632110530612/1255293632110530612
:flag_gb: https://discord.com/channels/802528604067201055/1255293651756650616/1255293651756650616
or on GitHub: <https://github.com/creazy231/tools-for-autodarts/issues>

_Updates getting rolled out right now. Keep an eye on the GitHub page for the status of each browser:_ <https://github.com/creazy231/tools-for-autodarts/tree/main?tab=readme-ov-file#tools-for-autodarts>
