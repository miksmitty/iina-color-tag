// IINA plugin: apply a macOS Finder color tag to the currently playing file.
//
// Finder tags are stored in the extended attribute
// `com.apple.metadata:_kMDItemUserTags` as a plist array of strings,
// where each string is "Name\nColorIndex" (e.g. "Red\n6").
// We shell out to xattr/plutil via utils.exec to read and write it.

const { console, core, event, file, menu, utils } = iina;

const XATTR_KEY = "com.apple.metadata:_kMDItemUserTags";

// Finder's standard color indices: 0=none, 1=Gray, 2=Green, 3=Purple,
// 4=Blue, 5=Yellow, 6=Red, 7=Orange.
const COLORS = [
  { name: "Red", index: 6, key: "Alt+1" },
  { name: "Orange", index: 7, key: "Alt+2" },
  { name: "Yellow", index: 5, key: "Alt+3" },
  { name: "Green", index: 2, key: "Alt+4" },
  { name: "Blue", index: 4, key: "Alt+5" },
  { name: "Purple", index: 3, key: "Alt+6" },
  { name: "Gray", index: 1, key: "Alt+7" },
];

const COLOR_NAMES = new Set(COLORS.map((c) => c.name));

// Triage mode — auto-tagging Red on navigate and skipping already-tagged
// files — only applies inside these folder trees (the ones Hazel sweeps).
// Everywhere else, [ and ] are plain folder navigation.
const REVIEW_FOLDERS = ["/Volumes/Lexar_2TB/D_Review"];

// The local RSS parser app; ⌥Q sends the playing file there for an
// alternate-quality search via its /?altq=<filename> deep link.
const RSS_PARSER_URL = "http://localhost:3000";

function isInReviewFolder(path) {
  const p = nfc(path).toLowerCase();
  return REVIEW_FOLDERS.some((folder) => {
    const base = nfc(folder).toLowerCase().replace(/\/+$/, "");
    return p === base || p.startsWith(base + "/");
  });
}

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

async function hasColorTag(path) {
  return (await readTags(path)).some(isStandardColorTag);
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

const VIDEO_EXTS = new Set([
  "mp4", "m4v", "mkv", "mov", "avi", "wmv", "flv", "webm", "ts", "m2ts",
  "mpg", "mpeg", "vob", "3gp", "ogv", "rmvb", "divx",
]);

function fileExt(name) {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.substring(i + 1).toLowerCase();
}

// NFC-normalize before comparing: the path from core.status.url and the
// names from file.list can differ in Unicode form for accented characters.
function nfc(s) {
  return s.normalize ? s.normalize("NFC") : s;
}

function compareFinderStyle(a, b) {
  return nfc(a).localeCompare(nfc(b), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

// When navigating away from a file that has no color tag yet, mark it Red so
// every visited file leaves the triage pass tagged one way or another.
async function autoTagRedIfUntagged(path) {
  // The file may already be gone: Hazel and similar tools can move it away
  // seconds after it gets tagged, while IINA keeps playing from the open
  // file handle.
  if (!file.exists(path)) return;
  try {
    const tags = await readTags(path);
    if (tags.some(isStandardColorTag)) return;
    const red = COLORS.find((c) => c.name === "Red");
    await writeTags(path, tags.concat([red.name + "\n" + red.index]), red.index);
    core.osd("Auto-tagged Red");
  } catch (err) {
    console.error("Auto-tag failed: " + err);
    core.osd("Color Tag: auto-tag failed (" + err + ")");
  }
}

function listSiblings(dir) {
  return (file.list(dir, { includeSubDir: false }) || [])
    .filter(
      (e) =>
        !e.isDir &&
        !e.filename.startsWith(".") && // AppleDouble ._* sidecars etc.
        VIDEO_EXTS.has(fileExt(e.filename)),
    )
    .map((e) => dir + "/" + e.filename)
    .sort(compareFinderStyle);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function statFile(path) {
  const { status, stdout } = await utils.exec("/usr/bin/stat", [
    "-f",
    "%z %m",
    path,
  ]);
  if (status !== 0) return null;
  const parts = stdout.trim().split(/\s+/).map(Number);
  return { size: parts[0], mtime: parts[1] };
}

// A file is safe to hand to mpv if it exists, is non-empty, and is not still
// being written: a video that is mid-copy into the folder exists but fails to
// open ("Cannot open file or stream") because its tail isn't there yet. Files
// untouched for a few seconds are assumed complete; recently modified ones
// get a size-stability probe.
async function isSafeToOpen(path) {
  const s1 = await statFile(path);
  if (!s1 || s1.size === 0) return false;
  if (Date.now() / 1000 - s1.mtime > 5) return true;
  await sleep(300);
  const s2 = await statFile(path);
  return s2 !== null && s2.size === s1.size;
}

// Pick the file adjacent to `ref` in its folder. `ref` itself may no longer
// exist (moved or deleted by Hazel mid-session); in that case navigate
// relative to where it would sort among the remaining files.
function pickTarget(ref, offset) {
  const dir = ref.substring(0, ref.lastIndexOf("/"));
  const siblings = listSiblings(dir);
  const i = siblings.findIndex((p) => nfc(p) === nfc(ref));
  if (i !== -1) return siblings[i + offset] || null;
  const after = siblings.findIndex((p) => compareFinderStyle(p, ref) > 0);
  if (offset > 0) return after === -1 ? null : siblings[after];
  return after === -1
    ? siblings[siblings.length - 1] || null
    : siblings[after - 1] || null;
}

async function navigateFolder(offset) {
  try {
    const path = currentFilePath();
    if (!path) {
      core.osd("Color Tag: no local file is playing");
      return;
    }
    const triage = isInReviewFolder(path);
    if (triage) await autoTagRedIfUntagged(path);
    let ref = path;
    for (let attempt = 0; attempt < 32; attempt++) {
      const target = pickTarget(ref, offset);
      if (!target) {
        core.osd(
          offset > 0 ? "No next file in folder" : "No previous file in folder",
        );
        return;
      }
      // In the review folder, already-tagged files have been triaged — a
      // Red one is just waiting for Hazel to delete it, which can lag by a
      // few seconds. Never land on them.
      const tagged = triage && (await hasColorTag(target));
      if (!tagged && (await isSafeToOpen(target))) {
        core.open(target);
        return;
      }
      // The picked file was tagged already, deleted between listing and
      // opening (e.g. by a Hazel delete rule), or is still being copied in.
      // Continue the search from its sort position.
      ref = target;
    }
    core.osd("Folder is changing too quickly — try again");
  } catch (err) {
    console.error("Navigation failed: " + err);
    core.osd("Color Tag: navigation failed (" + err + ")");
  }
}

const menuItems = {
  None: menu.item("None", () => applyColor(null), { keyBinding: "Alt+0" }),
};
const tagMenu = menu.item("Tag Color");
tagMenu.addSubMenuItem(menuItems.None);
tagMenu.addSubMenuItem(menu.separator());
for (const color of COLORS) {
  menuItems[color.name] = menu.item(color.name, () => applyColor(color), {
    keyBinding: color.key,
  });
  tagMenu.addSubMenuItem(menuItems[color.name]);
}
menu.addItem(tagMenu);
menu.addItem(
  menu.item("Next File in Folder", () => navigateFolder(1), {
    keyBinding: "]",
  }),
);
menu.addItem(
  menu.item("Previous File in Folder", () => navigateFolder(-1), {
    keyBinding: "[",
  }),
);
menu.addItem(
  menu.item(
    "Search Alternate Quality…",
    async () => {
      const path = currentFilePath();
      if (!path) {
        core.osd("Color Tag: no local file is playing");
        return;
      }
      const name = path.substring(path.lastIndexOf("/") + 1);
      try {
        await utils.exec("/usr/bin/open", [
          RSS_PARSER_URL + "/?altq=" + encodeURIComponent(name),
        ]);
        core.osd("Searching alternate qualities…");
      } catch (err) {
        console.error("Alternate-quality search failed: " + err);
        core.osd("Color Tag: couldn't open RSS parser (" + err + ")");
      }
    },
    { keyBinding: "Alt+q" },
  ),
);

async function refreshCheckmarks() {
  try {
    const path = currentFilePath();
    const current = path ? await currentColorName(path) : null;
    menuItems.None.selected = current === null && path !== null;
    for (const color of COLORS) {
      menuItems[color.name].selected = current === color.name;
    }
  } catch (err) {
    console.error("Failed to refresh menu checkmarks: " + err);
  }
}

event.on("mpv.file-loaded", () => {
  refreshCheckmarks();
});
