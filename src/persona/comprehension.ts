import type { AvereyConfig } from "../config.js";
import type { Rng } from "../core/rng.js";

/**
 * Words an average 7th-8th grader knows even though they are long.
 * Short words (5 letters or fewer) are always assumed known.
 */
const COMMON = `
about above across actually address after afternoon again against almost already also although always
amazing among animal another answer anyone anything anyway anywhere appear around attention
available away baby balance because become before began behind believe belong beside better between
beyond bicycle birthday bottom brother building business busy camera captain careful carry catch
center century certain change chapter character check children choice choose circle class clean clear
climb close clothes coffee college color combine comfortable common community company compare complete
computer consider continue control cook correct country couple course cousin cover crazy create
current customer daughter decide decision deep definitely describe desert design develop different
difficult dinner direction discover distance doctor double dream during early earth easily easy
education either else empty enemy energy engine enjoy enough entire environment especially even evening
event ever every everyone everything exactly example excited exercise expect experience explain
extra fall family famous farmer father favorite feeling female figure finally finger finish
fire first follow food foreign forest forget forward fourth friend front future garden gather general
gentle getting giant glass going government great ground group growing guess happen happy
healthy heard heavy height hello helpful high history holiday honest hospital hundred hungry hurry
husband idea imagine important include information inside instead interest interesting internet
island itself job join journey just kitchen knowledge language large later laugh learn leave
length lesson letter library light listen little living local lonely longer lucky machine magazine
making manage many market marry material matter maybe measure medicine member memory message middle
might million minute mirror missing mistake modern moment money month morning mother mountain
movie music nation natural nearly necessary neighbor never newspaper night noise normal nothing
notice number office often only opinion order ordinary other outside paper parent party
people perfect perhaps person picture piece place planet plant player please pocket point police
popular possible practice pretty prevent price printer prize probably problem produce project promise
proper protect public purpose question quickly quiet quite rather reach ready real really reason
receive recent record remember repeat report require research respect rest result return reward
right river rocket round safe satisfy school science search second secret section seem sentence serious
service several shadow share shoulder should signal silent silver simple since single sister sleep slowly
smile snow social someone something sometimes soon sorry sound special spend spirit spread spring square
stage start station stay still stomach stop store story straight strange stream street strong student
study subject success sudden suddenly suggest summer supper suppose sure surface surprise system table
teacher telephone television terrible thank their themselves there these thing think third those
though thought thousand through throw ticket tired today together tomorrow tonight toward town
trade travel trouble truck trust twice under understand unless until upon usually valley value
various village visit voice wait walk want watch water weather week weight welcome western whatever
wheel whenever where whether which while white whole whose window winter wish within without woman wonder
wonderful word work world worry would write wrong yellow yesterday young yourself
attachment document email meeting schedule website software password account download upload
feedback deadline budget invoice payment customer manager employee project update review
`
  .split(/\s+/)
  .filter(Boolean);

const COMMON_SET = new Set(COMMON);
const COMMON_BY_PREFIX3 = new Map<string, string[]>();
for (const w of COMMON) {
  if (w.length < 4) continue;
  const key = w.slice(0, 3);
  const list = COMMON_BY_PREFIX3.get(key) ?? [];
  list.push(w);
  COMMON_BY_PREFIX3.set(key, list);
}

export function countSyllables(word: string): number {
  let w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = w.match(/[aeiouy]{1,2}/g);
  return groups ? groups.length : 1;
}

function stems(word: string): string[] {
  const out = [word];
  for (const suffix of ["ing", "ed", "es", "s", "ly", "er", "est", "d"]) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) {
      out.push(word.slice(0, -suffix.length));
    }
  }
  return out;
}

function isKnownCommon(word: string): boolean {
  return stems(word).some((s) => COMMON_SET.has(s));
}

export function isHardWord(word: string): boolean {
  const w = word.toLowerCase();
  if (w.length <= 5) return false;
  if (isKnownCommon(w)) return false;
  const syl = countSyllables(w);
  if (syl >= 4 || w.length >= 10) return true;
  return syl === 3 && w.length >= 8;
}

function stripVerbatim(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ");
}

/** Hard words in the text, hardest first, lowercase and unique. */
export function findHardWords(
  text: string,
  known: Set<string>,
  limit: number,
): string[] {
  const clean = stripVerbatim(text);
  const seen = new Map<string, number>();
  const re = /[A-Za-z][A-Za-z'-]*/g;
  for (let m = re.exec(clean); m; m = re.exec(clean)) {
    const word = m[0].replace(/['-]+$/, "");
    const lower = word.toLowerCase();
    if (known.has(lower) || seen.has(lower)) continue;
    if (!isHardWord(lower)) continue;
    const before = clean.slice(0, m.index).trimEnd();
    const startsSentence = before === "" || /[.!?:\n]$/.test(before);
    if (/^[A-Z]/.test(word) && !startsSentence) continue; // probably a name
    seen.set(lower, countSyllables(lower) * 2 + lower.length);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

/** A plausible mix-up: a common word that starts the same way. */
export function malapropism(word: string, rng: Rng): string | undefined {
  const w = word.toLowerCase();
  for (let len = Math.min(5, w.length - 2); len >= 3; len--) {
    const prefix = w.slice(0, len);
    const pool = COMMON.filter(
      (c) => c.length >= 4 && c !== w && c.startsWith(prefix),
    );
    if (pool.length > 0) return rng.pick(pool);
  }
  const bucket = COMMON_BY_PREFIX3.get(w.slice(0, 3));
  if (bucket && bucket.length > 0) return rng.pick(bucket);
  // Nothing sounds alike: grab something that starts with the same letter.
  const sameLetter = COMMON.filter(
    (c) => c[0] === w[0] && c.length >= 5 && c.length <= 9,
  );
  return sameLetter.length > 0 ? rng.pick(sameLetter) : undefined;
}

export interface ComprehensionResult {
  /** Words Averey wants explained. If non-empty, Averey asks instead of working. */
  asked: string[];
  question?: string;
  misread: { word: string; as: string }[];
  skimmed: string[];
  /** The task text as Averey understood it. */
  text: string;
}

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1) {
    return replacement.toUpperCase();
  }
  if (/^[A-Z]/.test(original)) {
    return replacement[0]!.toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function replaceWord(text: string, word: string, replacement: string): string {
  const re = new RegExp(`\\b${word}\\b`, "gi");
  return text.replace(re, (m) => matchCase(m, replacement));
}

export function interpret(
  text: string,
  known: Set<string>,
  performance: number,
  cfg: AvereyConfig["comprehension"],
  rng: Rng,
): ComprehensionResult {
  const result: ComprehensionResult = {
    asked: [],
    misread: [],
    skimmed: [],
    text,
  };
  if (!cfg.enabled) return result;

  const hard = findHardWords(text, known, cfg.maxHardWords);
  const misreadChance = Math.min(
    1,
    cfg.misreadChance * Math.min(1.5, 1 / Math.max(performance, 0.01)),
  );

  let working = text;
  for (const word of hard) {
    const roll = rng.next();
    if (roll < cfg.askChance && result.asked.length < cfg.maxQuestions) {
      result.asked.push(word);
    } else if (roll < cfg.askChance + misreadChance) {
      const as = malapropism(word, rng);
      if (as) {
        result.misread.push({ word, as });
        working = replaceWord(working, word, as);
      } else {
        result.skimmed.push(word);
      }
    } else {
      result.skimmed.push(word);
    }
  }
  result.text = working;

  if (result.asked.length === 1) {
    result.question = `Sorry, what does "${result.asked[0]}" mean?`;
  } else if (result.asked.length > 1) {
    const list = result.asked.map((w) => `"${w}"`).join(" and ");
    result.question = `Sorry, I'm not sure what ${list} mean. Can you say it in simpler words?`;
  }
  return result;
}
