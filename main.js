// IINA plugin: apply a macOS Finder color tag to the currently playing file.
//
// Finder tags are stored in the extended attribute
// `com.apple.metadata:_kMDItemUserTags` as a plist array of strings,
// where each string is "Name\nColorIndex" (e.g. "Red\n6").
// We shell out to xattr/plutil via utils.exec to read and write it.

const { console, core, event, menu, utils } = iina;

const XATTR_KEY = "com.apple.metadata:_kMDItemUserTags";

// Finder's standard color indices: 0=none, 1=Gray, 2=Green, 3=Purple,
// 4=Blue, 5=Yellow, 6=Red, 7=Orange.
const COLORS = [
  { name: "Red", index: 6 },
  { name: "Orange", index: 7 },
  { name: "Yellow", index: 5 },
  { name: "Green", index: 2 },
  { name: "Blue", index: 4 },
  { name: "Purple", index: 3 },
  { name: "Gray", index: 1 },
];

const COLOR_NAMES = new Set(COLORS.map((c) => c.name));

// Prints the tag xattr as an XML plist on stdout; empty output if the file
// has no tags.
const READ_SCRIPT =
  'xattr -px com.apple.metadata:_kMDItemUserTags "$1" 2>/dev/null' +
  " | xxd -r -p | plutil -convert xml1 -o - - 2>/dev/null || true";

// $1 = file path, $2 = XML plist of the new tag array ("" = remove all tags),
// $3 = legacy Finder label color code (0-7, 0 = none).
//
// The color is stored in two places: the modern tags xattr (read by Finder's
// tag UI and Spotlight) and the legacy label bits 1-3 of byte 9 in
// com.apple.FinderInfo (read by Hazel's "Color Label" condition, AppleScript's
// `label index`, and other Carbon-era consumers). Finder writes both, so we do
// too.
const WRITE_SCRIPT = [
  "set -e",
  'f="$1"',
  'xml="$2"',
  'idx="${3:-0}"',
  'if [ -z "$xml" ]; then',
  '  xattr -d com.apple.metadata:_kMDItemUserTags "$f" 2>/dev/null || true',
  "else",
  '  tmp="$(mktemp)"',
  "  trap 'rm -f \"$tmp\"' EXIT",
  '  printf \'%s\' "$xml" > "$tmp"',
  '  plutil -convert binary1 "$tmp"',
  "  xattr -wx com.apple.metadata:_kMDItemUserTags \"$(xxd -p \"$tmp\" | tr -d '\\n')\" \"$f\"",
  "fi",
  'fi_hex="$(xattr -px com.apple.FinderInfo "$f" 2>/dev/null | tr -d \' \\n\')"',
  '[ "${#fi_hex}" -eq 64 ] || fi_hex="$(printf \'%064d\' 0)"',
  'b9="${fi_hex:18:2}"',
  'nb9="$(printf \'%02x\' $(( (0x$b9 & 0xF1) | (idx << 1) )))"',
  'fi_hex="${fi_hex:0:18}${nb9}${fi_hex:20}"',
  'if [ "$fi_hex" = "$(printf \'%064d\' 0)" ]; then',
  '  xattr -d com.apple.FinderInfo "$f" 2>/dev/null || true',
  "else",
  '  xattr -wx com.apple.FinderInfo "$fi_hex" "$f"',
  "fi",
].join("\n");

function currentFilePath() {
  const url = core.status.url;
  if (!url || !url.startsWith("file://")) return null;
  return decodeURIComponent(url.replace(/^file:\/\/(localhost)?/, ""));
}

function decodeXML(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeXML(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// A tag string counts as a plain color tag only if it is exactly one of the
// seven standard names plus its index; custom tags like "Important\n6" keep
// their color and are left alone.
function isStandardColorTag(tag) {
  const [name, index] = tag.split("\n");
  return COLOR_NAMES.has(name) && /^[0-7]$/.test(index || "");
}

async function readTags(path) {
  const { status, stdout } = await utils.exec("/bin/bash", [
    "-c",
    READ_SCRIPT,
    "iina-color-tag",
    path,
  ]);
  if (status !== 0 || !stdout.includes("<array>")) return [];
  const tags = [];
  const re = /<string>([\s\S]*?)<\/string>/g;
  let m;
  while ((m = re.exec(stdout))) tags.push(decodeXML(m[1]));
  return tags;
}

async function writeTags(path, tags, colorIndex) {
  let xml = "";
  if (tags.length > 0) {
    xml =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"' +
      ' "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><array>' +
      tags.map((t) => "<string>" + encodeXML(t) + "</string>").join("") +
      "</array></plist>";
  }
  const { status, stderr } = await utils.exec("/bin/bash", [
    "-c",
    WRITE_SCRIPT,
    "iina-color-tag",
    path,
    xml,
    String(colorIndex || 0),
  ]);
  if (status !== 0) throw new Error("xattr failed: " + stderr);
}

async function currentColorName(path) {
  const tags = await readTags(path);
  const colorTag = tags.find(isStandardColorTag);
  return colorTag ? colorTag.split("\n")[0] : null;
}

// color = null means "remove the color tag".
async function applyColor(color) {
  const path = currentFilePath();
  if (!path) {
    core.osd("Color Tag: no local file is playing");
    return;
  }
  try {
    const kept = (await readTags(path)).filter((t) => !isStandardColorTag(t));
    if (color) kept.push(color.name + "\n" + color.index);
    await writeTags(path, kept, color ? color.index : 0);
    core.osd(color ? "Tagged " + color.name : "Color tag removed");
    refreshCheckmarks();
  } catch (err) {
    console.error("Failed to set tag: " + err);
    core.osd("Color Tag: failed (" + err + ")");
  }
}

const menuItems = { None: menu.item("None", () => applyColor(null)) };
const tagMenu = menu.item("Tag Color");
tagMenu.addSubMenuItem(menuItems.None);
tagMenu.addSubMenuItem(menu.separator());
for (const color of COLORS) {
  menuItems[color.name] = menu.item(color.name, () => applyColor(color));
  tagMenu.addSubMenuItem(menuItems[color.name]);
}
menu.addItem(tagMenu);

async function refreshCheckmarks() {
  const path = currentFilePath();
  const current = path ? await currentColorName(path) : null;
  menuItems.None.selected = current === null && path !== null;
  for (const color of COLORS) {
    menuItems[color.name].selected = current === color.name;
  }
}

event.on("mpv.file-loaded", () => {
  refreshCheckmarks();
});
