// IINA plugin: apply a macOS Finder color tag to the currently playing file.
//
// Finder tags are stored in the extended attribute
// `com.apple.metadata:_kMDItemUserTags` as a plist array of strings,
// where each string is "Name\nColorIndex" (e.g. "Red\n6").
// We shell out to xattr/plutil via utils.exec to read and write it.

const { console, core, event, file, menu, overlay, utils } = iina;

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

// CSS colors for the tag flash badge, matching Finder's tag swatches.
const BADGE_COLORS = {
  Red: "#ff3b30",
  Orange: "#ff9500",
  Yellow: "#ffcc00",
  Green: "#28cd41",
  Blue: "#007aff",
  Purple: "#af52de",
  Gray: "#8e8e93",
};

// --- Tag flash: a brief badge over the video confirming what was tagged ---
// The overlay is set up lazily on first use: touching the overlay API at
// plugin-load time throws during IINA startup (before the player window's
// overlay exists), which killed the whole plugin — no menu, no keybindings.
let overlayReady = false;
function ensureOverlay() {
  if (overlayReady) return;
  overlay.simpleMode();
  overlay.setStyle(`
    body { margin: 0; overflow: hidden; }
    .tag-flash {
      position: absolute; top: 24px; right: 24px;
      transform-origin: top right;
      display: flex; align-items: center; gap: 14px;
      padding: 18px 30px; border-radius: 18px;
      background: rgba(28, 28, 30, 0.82);
      font: 600 30px -apple-system, BlinkMacSystemFont, sans-serif;
      color: #fff; white-space: nowrap;
      animation: tag-flash 1.15s ease-out forwards;
    }
    .tag-flash .dot {
      width: 34px; height: 34px; border-radius: 50%;
      background: var(--c);
      box-shadow: 0 0 14px 2px var(--c);
    }
    .tag-flash.removed .dot {
      background: transparent; box-shadow: none;
      border: 3px solid #8e8e93;
    }
    @keyframes tag-flash {
      0%   { opacity: 0; transform: scale(0.7); }
      12%  { opacity: 1; transform: scale(1); }
      70%  { opacity: 1; transform: scale(1); }
      100% { opacity: 0; transform: scale(1); }
    }
  `);
  overlayReady = true;
}

let flashToken = 0;
// colorName = null draws the hollow "tag removed" dot.
function flashTag(label, colorName) {
  try {
    ensureOverlay();
    const token = ++flashToken;
    const c = BADGE_COLORS[colorName] || "#8e8e93";
    overlay.setContent(
      `<div class="tag-flash${colorName ? "" : " removed"}" style="--c:${c}">` +
        `<span class="dot"></span><span>${label}</span></div>`,
    );
    overlay.show();
    // Hide only if no newer flash has replaced this one in the meantime
    setTimeout(() => {
      if (token === flashToken) overlay.hide();
    }, 1200);
  } catch (err) {
    // The badge is cosmetic - never let it break tagging. Fall back to OSD.
    console.error("Tag flash overlay failed: " + err);
    core.osd(label);
  }
}

// Triage mode — auto-tagging Red on navigate and skipping already-tagged
// files — only applies inside these folder trees (the ones Hazel sweeps).
// Everywhere else, [ and ] are plain folder navigation.
const REVIEW_FOLDERS = ["/Volumes/Lexar_2TB/D_Review"];

// The local RSS parser app; ⌥Q sends the playing file there for an
// alternate-quality search (/?altq=<filename>) and ⌥P for a performer
// search (/?performer=<filename>, name extracted on the parser side).
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
    if (color) flashTag("Tagged " + color.name, color.name);
    else flashTag("Color tag removed", null);
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
    flashTag("Auto-tagged Red", "Red");
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
// Send the playing file's name to the RSS parser via one of its deep links
// (/?altq=... or /?performer=...), opening it in the default browser.
async function sendToRssParser(param, osdMessage) {
  const path = currentFilePath();
  if (!path) {
    core.osd("Color Tag: no local file is playing");
    return;
  }
  const name = path.substring(path.lastIndexOf("/") + 1);
  try {
    await utils.exec("/usr/bin/open", [
      RSS_PARSER_URL + "/?" + param + "=" + encodeURIComponent(name),
    ]);
    core.osd(osdMessage);
  } catch (err) {
    console.error("RSS parser deep link failed: " + err);
    core.osd("Color Tag: couldn't open RSS parser (" + err + ")");
  }
}

menu.addItem(
  menu.item(
    "Search Alternate Quality…",
    () => sendToRssParser("altq", "Searching alternate qualities…"),
    { keyBinding: "Alt+q" },
  ),
);
menu.addItem(
  menu.item(
    "Search Performer…",
    () => sendToRssParser("performer", "Searching performer…"),
    { keyBinding: "Alt+p" },
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
  // Warm up the overlay webview now: simple-mode content set in the same
  // tick as the first setup call never renders (the webview loads
  // asynchronously), so without this the FIRST tag flash after launch
  // would be lost.
  try {
    ensureOverlay();
  } catch (err) {
    console.error("Overlay warm-up failed: " + err);
  }
});
