import { describe, expect, it } from 'vitest';
import { CandidateIndex, assignIdentities, baseName, classFromInstances } from '../../packages/pipeline/src/match.ts';

const C = (qid: string, label: string, inception: number | null, dissolved: number | null, sitelinks = 50, aliases: string[] = []) => ({ qid, label, aliases, inception, dissolved, sitelinks });
const idx = new CandidateIndex([
  C('Q142', 'France', 843, null, 300),
  C('Q70972', 'Kingdom of France', 987, 1792.7, 80, ['France']),
  C('Q58296', 'French First Republic', 1792.7, 1804.4, 60, ['France']),
  C('Q2277', 'Roman Empire', -26, 395, 200),
  C('Q17167', 'Roman Republic', -508, -26, 150),
  C('Q1', 'Atlantis', null, null, 90),
]);

describe('temporal entity matching', () => {
  it('splits one map name across the states it was', () => {
    const s = assignIdentities('France', 1700, 1800, idx);
    expect(s.map((x) => x.qid)).toEqual(['Q70972', 'Q58296']);
    expect(s[0]!.to).toBeCloseTo(1792.7);
    expect(s[1]!.to).toBe(1800);
  });
  it('picks the specific state over the long-lived catch-all', () => {
    expect(assignIdentities('France', 1500, 1510, idx)[0]!.qid).toBe('Q70972');
  });
  it('never links a state outside its documented existence', () => {
    expect(assignIdentities('Roman Empire', 1000, 1100, idx)).toEqual([]);
    expect(assignIdentities('Kingdom of France', 1900, 1950, idx)).toEqual([]);
  });
  it('finds templated names', () => {
    const i = new CandidateIndex([C('Q9', 'Empire of Japan', 1868, 1947, 80)]);
    expect(assignIdentities('Japan', 1900, 1910, i)[0]!.qid).toBe('Q9');
  });
  it('accepts undated items only with low confidence', () => {
    const s = assignIdentities('Atlantis', 1000, 1100, idx);
    expect(s[0]!.confidence).toBeLessThanOrEqual(0.5);
    expect(s[0]!.method).toContain('undated');
  });
  it('ignores map annotations', () => {
    expect(baseName('Madagascar (France)')).toBe('madagascar');
    expect(baseName('Đại Việt')).toBe('dai viet');
  });
  it('classifies by what Wikidata calls it, dependency first', () => {
    expect(classFromInstances(['colony', 'kingdom'])).toBe('dependency');
    expect(classFromInstances(['historical country', 'empire'])).toBe('empire');
    expect(classFromInstances(['archaeological culture'])).toBe('culture');
    expect(classFromInstances(['thing'])).toBeNull();
  });
});
