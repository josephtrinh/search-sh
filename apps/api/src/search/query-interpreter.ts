import type { SearchFilters } from "@samplehub/contracts";

type DerivedField = "color" | "origin" | "effect" | "material" | "surface";

interface AliasRule {
  pattern: RegExp;
  field: DerivedField;
  values: string[];
  canonical: string;
}

const RULES: AliasRule[] = [
  { pattern: /\b(?:italian|italy)\b|意大利/giu, field: "origin", values: ["Italy"], canonical: "Italy" },
  { pattern: /\b(?:spanish|spain)\b|西班牙/giu, field: "origin", values: ["Spain"], canonical: "Spain" },
  { pattern: /\b(?:chinese|china)\b|中國|中国/giu, field: "origin", values: ["China"], canonical: "China" },
  { pattern: /\b(?:grey|gray)\b|灰色/giu, field: "color", values: ["Grey"], canonical: "Grey" },
  { pattern: /\bbeige\b|米色/giu, field: "color", values: ["Beige"], canonical: "Beige" },
  { pattern: /\bwhite\b|白色/giu, field: "color", values: ["White"], canonical: "White" },
  { pattern: /\bblack\b|黑色/giu, field: "color", values: ["Black"], canonical: "Black" },
  { pattern: /\bbrown\b|棕色|啡色/giu, field: "color", values: ["Brown"], canonical: "Brown" },
  { pattern: /\b(?:wood(?:en)?\s+(?:effect|look|grain))\b|木紋|木纹/giu, field: "effect", values: ["Wood"], canonical: "Wood" },
  { pattern: /\b(?:marble(?:\s+(?:effect|look|pattern))?)\b|大理石紋|大理石纹|大理石/giu, field: "effect", values: ["Marble"], canonical: "Marble" },
  { pattern: /\b(?:stone\s+(?:effect|look))\b|石紋|石纹/giu, field: "effect", values: ["Stone"], canonical: "Stone" },
  { pattern: /\bterrazzo\b|水磨石/giu, field: "effect", values: ["Terrazzo"], canonical: "Terrazzo" },
  { pattern: /\b(?:porcelain(?:\s+tile)?)\b|瓷磚|瓷砖/giu, field: "material", values: ["Porcelain Tile"], canonical: "Porcelain Tile" },
  { pattern: /\b(?:non[- ]?slip|anti[- ]?slip|slip[- ]?resistant)\b|防滑/giu, field: "surface", values: ["Grip R11", "Grip R12"], canonical: "Grip" },
];

const NEGATION = /(?:\bnot|\bno|\bwithout|非|不要|不含)\s*$/iu;

export interface QueryInterpretation {
  lexicalQuery: string;
  derivedFilters: Partial<SearchFilters>;
}

export function interpretQuery(query: string): QueryInterpretation {
  const derived = new Map<DerivedField, Set<string>>();
  let lexicalQuery = query;
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0;
    let accepted = false;
    lexicalQuery = lexicalQuery.replace(rule.pattern, (matched, offset: number, whole: string) => {
      const start = Number(offset);
      if (NEGATION.test(whole.slice(Math.max(0, start - 16), start))) return matched;
      accepted = true;
      return ` ${rule.canonical} `;
    });
    if (accepted) {
      const values = derived.get(rule.field) ?? new Set<string>();
      rule.values.forEach((value) => values.add(value));
      derived.set(rule.field, values);
    }
  }
  return {
    lexicalQuery: lexicalQuery.replace(/\s+/g, " ").trim(),
    derivedFilters: Object.fromEntries([...derived.entries()].map(([key, values]) => [key, [...values]])),
  };
}
