export const tintPresets = [
  { id: "blue", label: "\u84dd", rgb: "44, 62, 80", accent: "94, 163, 255" },
  { id: "teal", label: "\u9752", rgb: "28, 73, 76", accent: "45, 212, 191" },
  { id: "green", label: "\u7eff", rgb: "34, 68, 50", accent: "74, 222, 128" },
  { id: "purple", label: "\u7d2b", rgb: "58, 47, 80", accent: "168, 139, 250" },
  { id: "gray", label: "\u7070", rgb: "46, 52, 58", accent: "180, 190, 200" },
];

export type WidgetTheme = (typeof tintPresets)[number];
