// @vitest-environment jsdom
//
// The Executive dashboard's visual primitives. These are small, but two of them
// carry real obligations:
//
//   * CountUp animates a number with requestAnimationFrame. An animated count
//     is exactly what `prefers-reduced-motion` exists to suppress (WCAG 2.3.3),
//     and CSS can't stop a JS animation — so this one has to check the
//     preference itself.
//   * ProgressRing must draw a truthful arc. A ring that reads "5/7" while the
//     stroke shows half is worse than plain text.

import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { Heart } from "lucide-react";
import {
  CountUp, ProgressRing, Medallion, MiniBars, Pill, toneForDays, prefersReducedMotion,
} from "../client/src/components/dashboard/visuals";

/** jsdom has no matchMedia; install one whose answer we control. */
function stubMotionPreference(reduce: boolean) {
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && /prefers-reduced-motion/.test(q),
    media: q, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => { stubMotionPreference(false); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("CountUp", () => {
  it("lands on the exact value, animated", async () => {
    render(<CountUp value={22} duration={20} />);
    await act(async () => { await new Promise(r => setTimeout(r, 80)); });
    expect(document.body.textContent).toBe("22");
  });

  it("skips straight to the value when the user asked for reduced motion", () => {
    stubMotionPreference(true);
    render(<CountUp value={140} />);
    // No frames, no ramp — the final number on the very first paint.
    expect(document.body.textContent).toBe("140");
  });

  it("formats large numbers with separators", () => {
    stubMotionPreference(true);
    render(<CountUp value={2500} />);
    expect(document.body.textContent).toBe("2,500");
  });

  it("counts down as well as up", async () => {
    stubMotionPreference(true);
    const { rerender } = render(<CountUp value={9} />);
    rerender(<CountUp value={3} />);
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(document.body.textContent).toBe("3");
  });

  it("reports the preference it acts on", () => {
    stubMotionPreference(true);
    expect(prefersReducedMotion()).toBe(true);
    stubMotionPreference(false);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("ProgressRing", () => {
  const circles = () => Array.from(document.querySelectorAll("circle"));

  it("draws an arc proportional to the value", () => {
    render(<ProgressRing value={1} total={4} accent="155 60% 45%" size={60} stroke={6} />);
    const [, progress] = circles();
    const r = Number(progress.getAttribute("r"));
    const circumference = 2 * Math.PI * r;
    // A quarter done → three quarters of the stroke still hidden.
    expect(Number(progress.getAttribute("stroke-dashoffset"))).toBeCloseTo(circumference * 0.75, 1);
  });

  it("shows a full ring at 100% and an empty one at 0%", () => {
    const { rerender } = render(<ProgressRing value={4} total={4} accent="155 60% 45%" />);
    expect(Number(circles()[1].getAttribute("stroke-dashoffset"))).toBeCloseTo(0, 5);
    rerender(<ProgressRing value={0} total={4} accent="155 60% 45%" />);
    const r = Number(circles()[1].getAttribute("r"));
    expect(Number(circles()[1].getAttribute("stroke-dashoffset"))).toBeCloseTo(2 * Math.PI * r, 1);
  });

  it("never divides by zero", () => {
    render(<ProgressRing value={0} total={0} accent="155 60% 45%" />);
    expect(Number(circles()[1].getAttribute("stroke-dashoffset"))).not.toBeNaN();
  });

  it("labels itself for screen readers and shows the count", () => {
    render(<ProgressRing value={3} total={7} accent="155 60% 45%" />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("3 of 7 complete");
    expect(document.body.textContent).toContain("3/7");
  });
});

describe("the rest", () => {
  it("Medallion renders its icon inside a tinted circle, hidden from AT", () => {
    const { container } = render(<Medallion icon={Heart} accent="350 85% 62%" />);
    const badge = container.querySelector(".medallion") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.getAttribute("aria-hidden")).toBe("true");
    expect(badge.style.getPropertyValue("--accent-hsl")).toBe("350 85% 62%");
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("MiniBars scales every column against the tallest", () => {
    const { container } = render(<MiniBars values={[1, 2, 4]} accent="215 70% 58%" />);
    const bars = Array.from(container.querySelectorAll("span")) as HTMLElement[];
    expect(bars).toHaveLength(3);
    expect(bars[2].style.height).toBe("100%");
    expect(bars[1].style.height).toBe("50%");
  });

  it("maps days-until onto the documented colour system", () => {
    // red overdue · orange due today · yellow this week · blue informational
    expect(toneForDays(-1)).toBe("critical");
    expect(toneForDays(0)).toBe("warn");
    expect(toneForDays(3)).toBe("attention");
    expect(toneForDays(20)).toBe("info");
    expect(toneForDays(null)).toBe("info");
  });

  it("Pill can pulse for something expiring", () => {
    const { container } = render(<Pill tone="critical" pulse>Expired</Pill>);
    expect(container.firstElementChild?.className).toContain("pulse-attention");
  });
});
