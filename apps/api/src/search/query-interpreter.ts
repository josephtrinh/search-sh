import type { SearchFilters } from "@samplehub/contracts";

export const interpretedFields = ["color", "material", "effect", "surface", "origin"] as const;
export type InterpretedField = (typeof interpretedFields)[number];
export type AttributeVocabulary = Partial<Record<InterpretedField, readonly string[]>>;

export interface DerivedFilterGroup {
  canonical: string;
  fields: Partial<Record<InterpretedField, string[]>>;
}

export interface QueryInterpretation {
  lexicalQuery: string;
  derivedFilterGroups: DerivedFilterGroup[];
  derivedFilters: Partial<SearchFilters>;
}

export const defaultAttributeVocabulary: AttributeVocabulary = {
  color: ["Red", "White", "Grey", "Beige", "Black", "Brown", "Blue", "Green", "Orange", "Greige"],
  material: ["Porcelain Tile", "Sintered Stone", "Engineered Stone (Marble Based)", "Flexistone", "Terrazzo"],
  effect: ["Stone", "Wood", "Marble", "Concrete", "Terrazzo", "Pattern", "Paint"],
  surface: ["Matt", "Polished", "Grip R11", "Grip R12"],
  origin: ["Italy", "Spain", "China"],
};

interface CandidateMatch {
  start: number;
  end: number;
  canonical: string;
  fields: Partial<Record<InterpretedField, string[]>>;
  priority: number;
}

interface ConceptRule {
  pattern: RegExp;
  canonical: string;
  resolve: (vocabulary: AttributeVocabulary) => Partial<Record<InterpretedField, string[]>>;
}

const CONCEPT_RULES: ConceptRule[] = [
  exactRule(/\b(?:italian|italy)\b|意大利/giu, "Italy", "origin", ["Italy"]),
  exactRule(/\b(?:spanish|spain)\b|西班牙/giu, "Spain", "origin", ["Spain"]),
  exactRule(/\b(?:chinese|china)\b|中國|中国/giu, "China", "origin", ["China"]),
  exactRule(/\b(?:grey|gray)\b|灰色/giu, "Grey", "color", ["Grey", "Gray"]),
  exactRule(/\bbeige\b|米色/giu, "Beige", "color", ["Beige"]),
  exactRule(/\bwhite\b|白色/giu, "White", "color", ["White"]),
  exactRule(/\bblack\b|黑色/giu, "Black", "color", ["Black"]),
  exactRule(/\bbrown\b|棕色|啡色/giu, "Brown", "color", ["Brown"]),
  exactRule(/\bred\b|紅色|红色/giu, "Red", "color", ["Red"]),
  exactRule(/\bblue\b|藍色|蓝色/giu, "Blue", "color", ["Blue"]),
  exactRule(/\bgreen\b|綠色|绿色/giu, "Green", "color", ["Green"]),
  exactRule(/\borange\b|橙色/giu, "Orange", "color", ["Orange"]),
  familyRule(/\bwoods?(?:\s+(?:effect|look|grain))?\b|\bwooden\b|\btimber\b|木紋|木纹/giu, "Wood", ["material", "effect"], ["wood", "timber"]),
  familyRule(/\bmarbles?(?:\s+(?:effect|look|pattern))?\b|大理石紋|大理石纹|大理石/giu, "Marble", ["material", "effect"], ["marble"]),
  familyRule(/\bstones?(?:\s+(?:effect|look))?\b|石材|石紋|石纹/giu, "Stone", ["material", "effect"], ["stone"]),
  familyRule(/\bterrazzos?\b|水磨石/giu, "Terrazzo", ["material", "effect"], ["terrazzo"]),
  familyRule(/\bconcretes?\b|\bcements?\b|混凝土|水泥/giu, "Concrete", ["material", "effect"], ["concrete", "cement"]),
  familyRule(/\bporcelain(?:\s+tiles?)?\b|瓷磚|瓷砖/giu, "Porcelain Tile", ["material"], ["porcelain"]),
  familyRule(/\bceramic(?:\s+tiles?)?\b|陶瓷/giu, "Ceramic Tile", ["material"], ["ceramic"]),
  {
    pattern: /\b(?:non[- ]?slip|anti[- ]?slip|slip[- ]?resistant)\b|防滑/giu,
    canonical: "Grip",
    resolve: (vocabulary) => ({ surface: matchingValues(vocabulary, "surface", (value) => /grip|non.?slip|anti.?slip/i.test(value)) }),
  },
];

const NEGATION = /(?:\bnot|\bno|\bwithout|非|不要|不含)\s*$/iu;

export function interpretQuery(query: string, vocabulary: AttributeVocabulary = defaultAttributeVocabulary): QueryInterpretation {
  const candidates = [...conceptMatches(query, vocabulary), ...directVocabularyMatches(query, vocabulary)]
    .filter((match) => Object.values(match.fields).some((values) => values?.length))
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || b.priority - a.priority || a.start - b.start);
  const accepted: CandidateMatch[] = [];
  for (const candidate of candidates) {
    if (accepted.some((match) => candidate.start < match.end && candidate.end > match.start)) continue;
    accepted.push(candidate);
  }
  accepted.sort((a, b) => a.start - b.start);

  const groups: DerivedFilterGroup[] = [];
  const previousSingleFieldMatch = new Map<InterpretedField, CandidateMatch>();
  for (const match of accepted) {
    const fields = Object.keys(match.fields) as InterpretedField[];
    let mergeSingleField = false;
    if (fields.length === 1) {
      const field = fields[0]!;
      const previous = previousSingleFieldMatch.get(field);
      mergeSingleField = Boolean(previous && /\b(?:and|or)\b|以及|或|及/iu.test(query.slice(previous.end, match.start)));
      previousSingleFieldMatch.set(field, match);
    }
    addGroup(groups, { canonical: match.canonical, fields: match.fields }, mergeSingleField);
  }
  const derivedFilters: Partial<SearchFilters> = {};
  for (const group of groups) {
    for (const [field, values] of Object.entries(group.fields) as Array<[InterpretedField, string[]]>) {
      derivedFilters[field] = [...new Set([...(derivedFilters[field] ?? []), ...values])];
    }
  }

  let lexicalQuery = query;
  for (const match of [...accepted].sort((a, b) => b.start - a.start)) {
    lexicalQuery = `${lexicalQuery.slice(0, match.start)} ${match.canonical} ${lexicalQuery.slice(match.end)}`;
  }
  return { lexicalQuery: lexicalQuery.replace(/\s+/g, " ").trim(), derivedFilterGroups: groups, derivedFilters };
}

function conceptMatches(query: string, vocabulary: AttributeVocabulary): CandidateMatch[] {
  const matches: CandidateMatch[] = [];
  for (const rule of CONCEPT_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of query.matchAll(rule.pattern)) {
      const start = match.index ?? 0;
      if (NEGATION.test(query.slice(Math.max(0, start - 20), start))) continue;
      matches.push({ start, end: start + match[0].length, canonical: rule.canonical, fields: compactFields(rule.resolve(vocabulary)), priority: 2 });
    }
  }
  return matches;
}

function directVocabularyMatches(query: string, vocabulary: AttributeVocabulary): CandidateMatch[] {
  const matches: CandidateMatch[] = [];
  for (const field of interpretedFields) {
    for (const value of vocabulary[field] ?? []) {
      const pattern = phrasePattern(value);
      for (const match of query.matchAll(pattern)) {
        const start = match.index ?? 0;
        if (NEGATION.test(query.slice(Math.max(0, start - 20), start))) continue;
        matches.push({ start, end: start + match[0].length, canonical: value, fields: { [field]: [value] }, priority: 1 });
      }
    }
  }
  return matches;
}

function exactRule(pattern: RegExp, canonical: string, field: InterpretedField, candidates: string[]): ConceptRule {
  return { pattern, canonical, resolve: (vocabulary) => ({ [field]: matchingValues(vocabulary, field, (value) => candidates.some((candidate) => normalize(value) === normalize(candidate))) }) };
}

function familyRule(pattern: RegExp, canonical: string, fields: InterpretedField[], needles: string[]): ConceptRule {
  return { pattern, canonical, resolve: (vocabulary) => Object.fromEntries(fields.map((field) => [field,
    matchingValues(vocabulary, field, (value) => needles.some((needle) => normalize(value).includes(normalize(needle))))])) };
}

function matchingValues(vocabulary: AttributeVocabulary, field: InterpretedField, predicate: (value: string) => boolean): string[] {
  return [...new Set((vocabulary[field] ?? []).filter(predicate))];
}

function compactFields(fields: Partial<Record<InterpretedField, string[]>>): Partial<Record<InterpretedField, string[]>> {
  return Object.fromEntries(Object.entries(fields).filter(([, values]) => values?.length)) as Partial<Record<InterpretedField, string[]>>;
}

function addGroup(groups: DerivedFilterGroup[], next: DerivedFilterGroup, mergeSingleField: boolean) {
  const fields = Object.keys(next.fields) as InterpretedField[];
  if (fields.length === 1) {
    const field = fields[0]!;
    const existing = groups.find((group) => Object.keys(group.fields).length === 1 && group.fields[field]);
    if (existing) {
      if (mergeSingleField) {
        existing.fields[field] = [...new Set([...(existing.fields[field] ?? []), ...(next.fields[field] ?? [])])];
        existing.canonical = `${existing.canonical} ${next.canonical}`;
      }
      return;
    }
  }
  const signature = JSON.stringify(Object.fromEntries(Object.entries(next.fields).sort(([a], [b]) => a.localeCompare(b))));
  if (!groups.some((group) => JSON.stringify(Object.fromEntries(Object.entries(group.fields).sort(([a], [b]) => a.localeCompare(b)))) === signature)) groups.push(next);
}

function phrasePattern(value: string): RegExp {
  const escaped = normalize(value).split(" ").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
