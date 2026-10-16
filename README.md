# IINA Color Tag

An [IINA](https://iina.io) plugin that applies a macOS Finder color tag to the
currently playing video file — tag the keepers without leaving the player.

Adds a **Tag Color** submenu to IINA's **Plugins** menu with the seven standard
Finder colors plus **None**. The current file's color shows a checkmark.
Custom (non-color) Finder tags on the file are preserved.

## How it works

Finder tags live in the `com.apple.metadata:_kMDItemUserTags` extended
attribute as a binary plist array of `"Name\nColorIndex"` strings. The plugin
reads and writes that attribute with the system `xattr` and `plutil` tools via
IINA's `utils.exec` API. No third-party binaries required.

## Install (development)

Symlink the repo into IINA's plugin folder with an `.iinaplugin-dev` suffix:

```sh
ln -s "$(pwd)" ~/Library/Application\ Support/com.colliderli.iina/plugins/iina-color-tag.iinaplugin-dev
```

Then restart IINA. If the Plugins menu/preferences tab is missing, enable the
plugin system first:

```sh
defaults write com.colliderli.iina iinaEnablePluginSystem true
```

While iterating, use the **Reload** button next to the plugin in
IINA Settings → Plugins.

## Usage

Play a local video file, then pick **Plugins → Tag Color → Red** (or any other
color). An OSD message confirms the tag. **None** removes the color tag
(custom tags are kept). Verify in Finder — the file shows the color dot.

### Keyboard shortcuts

Shortcuts work whenever the player window is focused:

| Shortcut | Action |
| --- | --- |
| ⌥1 | Red |
| ⌥2 | Orange |
| ⌥3 | Yellow |
| ⌥4 | Green |
| ⌥5 | Blue |
| ⌥6 | Purple |
| ⌥7 | Gray |
| ⌥0 | Remove color tag |
| ] | Next file in folder |
| [ | Previous file in folder |
| ⌥Q | Search alternate quality in the RSS parser app |
| ⌥P | Search performer in the RSS parser app |

**Next/Previous File in Folder** plays the adjacent video file from the same
folder (Finder-style name order), regardless of the playlist — handy for
triaging a folder: watch, tag with ⌥1–⌥7, then ] to move on.

Inside the review folders listed in `REVIEW_FOLDERS` at the top of
[main.js](main.js) (including their subfolders), navigation runs in **triage
mode**: files that already have a color tag are skipped — they've been
triaged, and a Red one may just be waiting on a cleanup rule (e.g. Hazel)
to delete it — and navigating away from an untagged file auto-tags it Red
(see below). In any other folder, [ and ] are plain navigation: nothing is
tagged and nothing is skipped.

**Search Alternate Quality** (⌥Q) and **Search Performer** (⌥P) send the
playing file's name to the local RSS parser app (`RSS_PARSER_URL` in
[main.js](main.js), default `http://localhost:3000`) via its
`/?altq=<filename>` and `/?performer=<filename>` deep links — the same
searches its drag-a-file-in feature uses. The app's server must be running.

In triage mode, when you navigate away from a file that has **no color
tag**, it is automatically tagged **Red** — so every file you've visited
ends up tagged, either explicitly by you or Red by default. Only the seven
standard color tags count as "tagged" here; custom Finder tags alone won't
prevent the Red default.

To change them, edit the `key` values in [main.js](main.js) (mpv
[key binding format](https://mpv.io/manual/stable/#key-names), e.g.
`Meta+Alt+1` for ⌘⌥1) and reload the plugin.

## Limitations

- Only works for local files (`file://` URLs) — network streams have no
  Finder metadata.
- Files on volumes without extended-attribute support (some network shares)
  can't be tagged.
