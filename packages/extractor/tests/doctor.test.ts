import { describe, expect, it } from "vitest";
import { estimateRun, medianLatency, recommendSettings } from "../src/commands/doctor.js";

const BASE = {
  channels: 758,
  messages: 1_871_542,
  attachmentRatio: 0.05,
  users: 2000,
  emojis: 762,
  postsPageSize: 200,
  rateLimit: 8,
};

describe("estimateRun", () => {
  it("compte une page de messages par tranche de per_page", () => {
    const estimate = estimateRun({ ...BASE, messages: 1000, postsPageSize: 200 });
    expect(estimate.postPages).toBe(5);
  });

  it("arrondit la derniere page vers le haut", () => {
    expect(estimateRun({ ...BASE, messages: 1001, postsPageSize: 200 }).postPages).toBe(6);
  });

  it("divise les pages quand le serveur accepte une page plus grande", () => {
    const small = estimateRun(BASE);
    const large = estimateRun({ ...BASE, postsPageSize: 1000 });
    expect(large.postPages).toBe(Math.ceil(small.postPages / 5));
    expect(large.totalRequests).toBeLessThan(small.totalRequests);
  });

  it("montre que les pieces jointes dominent le total", () => {
    // C est le constat qui oriente toute optimisation : agir sur les pages de
    // messages ne peut pas suffire.
    const estimate = estimateRun(BASE);
    expect(estimate.attachments / estimate.totalRequests).toBeGreaterThan(0.8);
  });

  it("reduit la duree proportionnellement au debit", () => {
    const slow = estimateRun({ ...BASE, rateLimit: 8 });
    const fast = estimateRun({ ...BASE, rateLimit: 16 });
    expect(fast.durationMs).toBeCloseTo(slow.durationMs / 2, 0);
  });

  it("ne divise jamais par zero sur un debit nul", () => {
    expect(Number.isFinite(estimateRun({ ...BASE, rateLimit: 0 }).durationMs)).toBe(true);
  });

  it("reste coherent sur une archive vide", () => {
    const estimate = estimateRun({ ...BASE, channels: 0, messages: 0, users: 0, emojis: 0 });
    expect(estimate.postPages).toBe(0);
    expect(estimate.attachments).toBe(0);
  });
});

describe("medianLatency", () => {
  it("prend la valeur centrale sur un nombre impair", () => {
    expect(medianLatency([90, 80, 400])).toBe(90);
  });

  it("moyenne les deux valeurs centrales sur un nombre pair", () => {
    expect(medianLatency([80, 90, 100, 120])).toBe(95);
  });

  it("resiste a une valeur aberrante", () => {
    // Le premier appel porte l etablissement de la connexion TLS : la mediane
    // ne doit pas s en trouver deformee.
    expect(medianLatency([372, 90, 80])).toBe(90);
  });

  it("renvoie zero sans echantillon", () => {
    expect(medianLatency([])).toBe(0);
  });
});

describe("recommendSettings", () => {
  it("vise 80 % de la limite annoncee par le serveur", () => {
    const advice = recommendSettings({ latencyMs: 100, serverLimit: 10 });
    expect(advice.rateLimit).toBe(8);
  });

  it("vise un debit prudent quand le serveur n annonce aucune limite", () => {
    const advice = recommendSettings({ latencyMs: 90, serverLimit: undefined });
    expect(advice.rateLimit).toBe(30);
  });

  it("deduit la concurrence de la latence, pas d une constante", () => {
    // A debit vise egal, une instance lointaine exige plus de requetes en vol.
    const proche = recommendSettings({ latencyMs: 20, serverLimit: undefined });
    const lointaine = recommendSettings({ latencyMs: 300, serverLimit: undefined });
    expect(lointaine.concurrency).toBeGreaterThan(proche.concurrency);
  });

  it("propose une concurrence suffisante pour atteindre le debit vise", () => {
    const advice = recommendSettings({ latencyMs: 90, serverLimit: undefined });
    expect(advice.achievableRate).toBeGreaterThanOrEqual(advice.rateLimit);
  });

  it("ne depasse jamais la borne acceptee par --concurrency", () => {
    const advice = recommendSettings({ latencyMs: 5000, serverLimit: undefined });
    expect(advice.concurrency).toBeLessThanOrEqual(32);
  });

  it("ne descend jamais sous une requete en vol", () => {
    const advice = recommendSettings({ latencyMs: 1, serverLimit: 1 });
    expect(advice.concurrency).toBeGreaterThanOrEqual(1);
  });
});
