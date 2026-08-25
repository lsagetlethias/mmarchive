import { describe, expect, it } from "vitest";
import { estimateRun } from "../src/commands/doctor.js";

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
