import { expect, test } from "bun:test";
import { parseResetCredits } from "./codex-resets.ts";

test("reads and orders available expirations, excluding redeemed credits", () => {
  const result = parseResetCredits({available_count: 2, applicable_available_count: 0}, {
    available_count: 2, credits: [
      {status: "redeemed", expires_at: "2026-09-01T00:00:00Z"},
      {status: "available", expires_at: "2026-10-04T00:00:00Z"},
      {status: "available", expires_at: "2026-09-20T23:07:18.216632Z", is_supported_by_plan: true},
    ],
  });
  expect(result?.available).toBe(2);
  expect(result?.applicable).toBe(0);
  expect(result?.credits).toHaveLength(2);
  expect(result?.credits[0]?.expiresAt).toBeCloseTo(Date.parse("2026-09-20T23:07:18.216Z") / 1000);
  expect(result?.detailsComplete).toBe(true);
});
test("count-only data never invents expiration dates", () => {
  expect(parseResetCredits({available_count: 3})).toEqual({available:3, applicable:undefined, credits:[], detailsComplete:false});
  expect(parseResetCredits(undefined)).toBeUndefined();
});
test("distinguishes no expiration from unknown or malformed expiration", () => {
  const result = parseResetCredits({available_count:3}, {credits:[
    {status:"available",expires_at:null}, {status:"available"}, {status:"available",expires_at:"invalid"},
  ]});
  expect(result?.credits.map(c=>c.expiresAt)).toEqual([null,undefined,undefined]);
  expect(result?.detailsComplete).toBe(false);
});
test("fresh zero overrides old nonzero and partial details stay incomplete", () => {
  expect(parseResetCredits({available_count:3},{available_count:0,credits:[]})?.detailsComplete).toBe(true);
  expect(parseResetCredits({available_count:3},{credits:[{status:"available",expires_at:1790000000}]})?.detailsComplete).toBe(false);
});
test("supports numeric timestamps and nonexpiring credits", () => {
  const r=parseResetCredits({available_count:2,credits:[{status:"available",expires_at:null},{status:"available",expires_at:1790000000}]});
  expect(r?.credits[0]?.expiresAt).toBe(1790000000);
  expect(r?.detailsComplete).toBe(true);
});
