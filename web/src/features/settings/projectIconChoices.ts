import dynamicIconImports from "lucide-react/dynamicIconImports";

// Ordered picker choices are behavior data from the pinned reference.
export const popularIcons = ["folder-code", "code-2", "terminal", "globe-2", "server", "database", "bot", "sparkles", "smartphone", "monitor", "cloud-cog", "package", "book-open", "flask-conical", "shield-check", "rocket", "gamepad-2", "music", "image", "shopping-bag", "git-branch", "workflow", "wrench", "layers-3"];
export const emojiChoices = [
  ["💻", "Computer"], ["🛠️", "Tools"], ["🚀", "Rocket"], ["🤖", "Robot"], ["✨", "Sparkles"], ["⚡", "Lightning"], ["🌐", "Web"], ["📱", "Mobile"], ["🖥️", "Desktop"], ["⌨️", "Keyboard"], ["⚙️", "Gear"], ["🗄️", "Database"], ["☁️", "Cloud"], ["📦", "Package"], ["📚", "Books"], ["🧪", "Test tube"], ["🔒", "Lock"], ["🎮", "Game"], ["🎵", "Music"], ["🎬", "Movie"], ["🖼️", "Picture"], ["🛍️", "Shopping"], ["🔥", "Fire"], ["💡", "Idea"], ["🧩", "Puzzle"], ["📊", "Chart"], ["🧠", "Brain"], ["🦄", "Unicorn"], ["🐙", "Octopus"], ["🌱", "Seedling"],
] as const;
const installedIcons = Object.keys(dynamicIconImports).sort();
export function searchProjectIcons(query: string) {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, "-");
  return normalized ? installedIcons.filter((name) => name.includes(normalized)).slice(0, 60) : popularIcons;
}
export const iconChoiceLabel = (name: string) => name.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function pastedProjectEmoji(value: string): string | null {
  const first = graphemes.segment(value.trim())[Symbol.iterator]().next().value?.segment;
  return first && (/\p{Extended_Pictographic}/u.test(first) || /^\p{Regional_Indicator}{2}$/u.test(first) || /^[#*0-9]\uFE0F?\u20E3$/u.test(first)) ? first : null;
}
export function pickerMonogram(value: string) {
  const text = value.normalize("NFKC").trim().toUpperCase();
  const count = [...graphemes.segment(text)].length;
  const valid = text.length > 0 && text.length <= 32 && count <= 2 && /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\u200C\u200D]*$/u.test(text);
  return { text, valid };
}
