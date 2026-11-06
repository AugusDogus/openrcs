// Pairing verification emoji tables, ported from libgm pair_google.go.
// The phone shows one of these during Google-account (Gaia) pairing; the index
// comes from the UKEY2 auth string (see ukey2.ts).

/**
 * libgm `pairingEmojisV0`, copied verbatim. It contains duplicates (for example
 * "🍞"), which are kept because the table is indexed by position.
 */
export const pairingEmojisV0: readonly string[] = Object.freeze([
  "😁", "😅", "🤣", "🫠", "🥰", "😇", "🤩", "😘", "😜", "🤗", "🤔", "🤐", "😴", "🥶", "🤯", "🤠",
  "🥳", "🥸", "😎", "🤓", "🧐", "🥹", "😭", "😱", "😖", "🥱", "😮‍💨", "🤡", "💩", "👻", "👽", "🤖",
  "😻", "💌", "💘", "💕", "❤", "💢", "💥", "💫", "💬", "🗯", "💤", "👋", "🙌", "🙏", "✍", "🦶",
  "👂", "🧠", "🦴", "👀", "🧑", "🧚", "🧍", "👣", "🐵", "🐶", "🐺", "🦊", "🦁", "🐯", "🦓", "🦄",
  "🐑", "🐮", "🐷", "🐿", "🐰", "🦇", "🐻", "🐨", "🐼", "🦥", "🐾", "🐔", "🐥", "🐦", "🕊", "🦆",
  "🦉", "🪶", "🦩", "🐸", "🐢", "🦎", "🐍", "🐳", "🐬", "🦭", "🐠", "🐡", "🦈", "🪸", "🐌", "🦋",
  "🐛", "🐝", "🐞", "🪱", "💐", "🌸", "🌹", "🌻", "🌱", "🌲", "🌴", "🌵", "🌾", "☘", "🍁", "🍂",
  "🍄", "🪺", "🍇", "🍈", "🍉", "🍋", "🍌", "🍍", "🍎", "🍐", "🍒", "🍓", "🥝", "🥥", "🥑", "🥕",
  "🌽", "🌶", "🫑", "🥦", "🥜", "🍞", "🥐", "🥨", "🧀", "🍗", "🍔", "🍟", "🍕", "🌭", "🌮", "🥗",
  "🥣", "🍿", "🦀", "🦑", "🍦", "🍩", "🍪", "🍫", "🍰", "🍬", "🍭", "☕", "🫖", "🍹", "🥤", "🧊",
  "🥢", "🍽", "🥄", "🧭", "🏔", "🌋", "🏕", "🏖", "🪵", "🏗", "🏡", "🏰", "🛝", "🚂", "🛵", "🛴",
  "🛼", "🚥", "⚓", "🛟", "⛵", "✈", "🚀", "🛸", "🧳", "⏰", "🌙", "🌡", "🌞", "🪐", "🌠", "🌧",
  "🌀", "🌈", "☂", "⚡", "❄", "⛄", "🔥", "🎇", "🧨", "✨", "🎈", "🎉", "🎁", "🏆", "🏅", "⚽",
  "⚾", "🏀", "🏐", "🏈", "🎾", "🎳", "🏓", "🥊", "⛳", "⛸", "🎯", "🪁", "🔮", "🎮", "🧩", "🧸",
  "🪩", "🖼", "🎨", "🧵", "🧶", "🦺", "🧣", "🧤", "🧦", "🎒", "🩴", "👟", "👑", "👒", "🎩", "🧢",
  "💎", "🔔", "🎤", "📻", "🎷", "🪗", "🎸", "🎺", "🎻", "🥁", "📺", "🔋", "💻", "💿", "☎", "🕯",
  "💡", "📖", "📚", "📬", "✏", "✒", "🖌", "🖍", "📝", "💼", "📋", "📌", "📎", "🔑", "🔧", "🧲",
  "🪜", "🧬", "🔭", "🩹", "🩺", "🪞", "🛋", "🪑", "🛁", "🧹", "🧺", "🔱", "🏁", "🐪", "🐘", "🦃",
  "🍞", "🍜", "🍠", "🚘", "🤿", "🃏", "👕", "📸", "🏷", "✂", "🧪", "🚪", "🧴", "🧻", "🪣", "🧽",
  "🚸",
]);

const pairingEmojisAddedV1: readonly string[] = [
  "🍋‍🟩", "🐦‍🔥", "🐲", "🪅", "🦜", "🏺", "🗿", "🫐", "⛽", "🍱", "🥡", "🧋", "🍼", "📐",
];

const pairingEmojisRemovedV1: ReadonlySet<string> = new Set([
  "💻", "🤗", "💬", "👋", "😁", "😎", "😇", "🥰", "🤓", "🤩",
]);

/**
 * libgm `pairingEmojisV1`, derived exactly like its `init()`: deduplicate V0
 * keeping first occurrences, append the added list, then drop the removed set.
 */
export const pairingEmojisV1: readonly string[] = Object.freeze(
  [...new Set(pairingEmojisV0), ...pairingEmojisAddedV1].filter(
    (emoji) => !pairingEmojisRemovedV1.has(emoji),
  ),
);
