import type { ViewKey } from "./types";

type V2 = [number, number];

/** Desk centres on the office floor (x, z). Agents sit on the far (-z) side, facing the camera. */
export const DESKS: Record<string, V2> = {
  macro: [-10.5, -0.5], fundamental: [-6, -0.5], onchain: [-10.5, 3.2], flow: [-6, 3.2], technical: [-8.25, 6.9],
  quant: [-3, -7], risk: [8.75, -6.2], critic: [8.75, 0.3], fund_manager: [8.75, 6.8],
};

export const VIEWS: Record<ViewKey, { target: [number, number, number]; pos: [number, number, number] }> = {
  overview: { target: [0, 0, 0.5], pos: [0, 18.5, 21] },
  debate: { target: [0.5, 0.8, 0.5], pos: [0.5, 7.5, 9.5] },
  research: { target: [-8.2, 0.6, 3], pos: [-7.5, 8.5, 12.5] },
  risk: { target: [8.75, 0.6, 0.3], pos: [1.5, 10, 11] },
};
