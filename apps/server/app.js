"use strict";

/* ================================================================
   Falling Sand Lab — a tiny Powder-Game style particle simulator.
   Grid cells are simulated on a Uint8Array and rendered through a
   small offscreen canvas that is scaled up (pixelated) to the screen.
   ================================================================ */

const EMPTY = 0;
const SAND = 1;
const WATER = 2;
const ACID = 3;
const WALL = 4;

const CELL = 4; // screen pixels per simulation cell
const VARIANTS = 14; // colour shades per material
const BG = 0xff0b0d12; // packed ARGB background

const TOOL_KIND = {
  sand: SAND,
  water: WATER,
  acid: ACID,
  wall: WALL,
  erase: EMPTY,
};

const BASE_COLORS = {
  [SAND]: [226, 194, 128],
  [WATER]: [56, 118, 224],
  [ACID]: [152, 230, 66],
  [WALL]: [124, 127, 139],
};

/* ---------------- DOM ---------------- */

const canvas = document.getElementById("sim");
const ctx = canvas.getContext("2d", { alpha: false });
const stage = document.getElementById("stage");
const buffer = document.createElement("canvas");
const bctx = buffer.getContext("2d");

const materialsBar = document.getElementById("materials");
const brushInput = document.getElementById("brush");
const brushValue = document.getElementById("brushValue");
const brushPreview = document.getElementById("brushPreview");
const pauseBtn = document.getElementById("pauseBtn");
const pauseText = document.getElementById("pauseText");
const pauseIcon = document.getElementById("pauseIcon");
const stepBtn = document.getElementById("stepBtn");
const clearBtn = document.getElementById("clearBtn");
const fpsStat = document.getElementById("fpsStat");
const cellStat = document.getElementById("cellStat");

/* ---------------- grid state ---------------- */

let cols = 0;
let rows = 0;
let cells = new Uint8Array(0);
let mom = new Int8Array(0); // horizontal momentum of liquids
let tint = new Uint8Array(0); // per-particle colour shade
let image = null; // ImageData of the buffer
let pixels = null; // Uint32 view over image.data

let tool = "sand";
let brushSize = Number(brushInput.value);
let paused = false;
let aliveCount = 0;

/* ---------------- palette ---------------- */

const palette = new Uint32Array(5 * VARIANTS);

function clamp8(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value | 0;
}

function buildPalette() {
  for (let kind = SAND; kind <= WALL; kind++) {
    const [r, g, b] = BASE_COLORS[kind];
    const spread = kind === WALL ? 30 : 26;
    for (let v = 0; v < VARIANTS; v++) {
      const f = (v - (VARIANTS - 1) / 2) / ((VARIANTS - 1) / 2);
      const rr = clamp8(r + f * spread);
      const gg = clamp8(g + f * spread);
      const bb = clamp8(b + f * spread);
      palette[kind * VARIANTS + v] = (0xff << 24) | (bb << 16) | (gg << 8) | rr;
    }
  }
}

buildPalette();

/* ---------------- allocation / resize ---------------- */

function allocate(width, height) {
  const nextCells = new Uint8Array(width * height);
  const nextMom = new Int8Array(width * height);
  const nextTint = new Uint8Array(width * height);

  const copyW = Math.min(cols, width);
  const copyH = Math.min(rows, height);
  for (let y = 0; y < copyH; y++) {
    const from = y * cols;
    const to = y * width;
    nextCells.set(cells.subarray(from, from + copyW), to);
    nextMom.set(mom.subarray(from, from + copyW), to);
    nextTint.set(tint.subarray(from, from + copyW), to);
  }

  cols = width;
  rows = height;
  cells = nextCells;
  mom = nextMom;
  tint = nextTint;

  buffer.width = cols;
  buffer.height = rows;
  image = bctx.createImageData(cols, rows);
  pixels = new Uint32Array(image.data.buffer);

  for (let i = 0; i < tint.length; i++) {
    tint[i] = (Math.random() * VARIANTS) | 0;
  }
}

function resize() {
  const rect = stage.getBoundingClientRect();
  const nextCols = Math.max(24, Math.floor(rect.width / CELL));
  const nextRows = Math.max(24, Math.floor(rect.height / CELL));
  if (nextCols === cols && nextRows === rows) return;

  canvas.width = nextCols * CELL;
  canvas.height = nextRows * CELL;
  allocate(nextCols, nextRows);
  render();
}

/* ---------------- helpers ---------------- */

function setCell(index, kind) {
  cells[index] = kind;
  mom[index] = 0;
  tint[index] = (Math.random() * VARIANTS) | 0;
}

function swapCells(a, b) {
  const kc = cells[a];
  cells[a] = cells[b];
  cells[b] = kc;
  const mt = mom[a];
  mom[a] = mom[b];
  mom[b] = mt;
  const tt = tint[a];
  tint[a] = tint[b];
  tint[b] = tt;
}

function fillRect(x0, y0, width, height, kind) {
  const xs = Math.max(0, x0);
  const ys = Math.max(0, y0);
  const xe = Math.min(cols, x0 + width);
  const ye = Math.min(rows, y0 + height);
  for (let y = ys; y < ye; y++) {
    const row = y * cols;
    for (let x = xs; x < xe; x++) setCell(row + x, kind);
  }
}

function clearAll() {
  cells.fill(EMPTY);
  mom.fill(0);
  aliveCount = 0;
}

/* ---------------- simulation ---------------- */

function tryEat(self, target) {
  if (target < 0) return false;
  const kind = cells[target];
  if (kind === EMPTY || kind === ACID) return false;
  const chance = kind === WALL ? 0.012 : kind === SAND ? 0.07 : 0.045;
  if (Math.random() >= chance) return false;
  cells[target] = EMPTY;
  if (Math.random() < 0.35) {
    cells[self] = EMPTY;
    mom[self] = 0;
    return true;
  }
  return false;
}

function dissolve(index, self) {
  const x = index % cols;
  const y = (index / cols) | 0;
  if (x > 0 && tryEat(self, index - 1)) return;
  if (x < cols - 1 && tryEat(self, index + 1)) return;
  if (y > 0 && tryEat(self, index - cols)) return;
  if (y < rows - 1 && tryEat(self, index + cols)) return;
}

function fallSand(index, x, y) {
  if (y + 1 >= rows) return;
  const below = index + cols;
  const belowKind = cells[below];
  if (belowKind === EMPTY || belowKind === WATER || belowKind === ACID) {
    swapCells(index, below);
    return;
  }
  const dir = Math.random() < 0.5 ? -1 : 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const dx = attempt === 0 ? dir : -dir;
    const nx = x + dx;
    if (nx < 0 || nx >= cols) continue;
    const target = below + dx;
    const kind = cells[target];
    if (kind === EMPTY || kind === WATER || kind === ACID) {
      swapCells(index, target);
      return;
    }
  }
}

function flowLiquid(index, x, y, isAcid) {
  if (isAcid) dissolve(index, index);

  // straight down
  if (y + 1 < rows) {
    const below = index + cols;
    if (cells[below] === EMPTY) {
      swapCells(index, below);
      return;
    }
    // diagonal down
    const dir = Math.random() < 0.5 ? -1 : 1;
    for (let attempt = 0; attempt < 2; attempt++) {
      const dx = attempt === 0 ? dir : -dir;
      const nx = x + dx;
      if (nx < 0 || nx >= cols) continue;
      const target = below + dx;
      if (cells[target] === EMPTY) {
        swapCells(index, target);
        mom[target] = dx;
        return;
      }
    }
  }

  // sideways — keep the previous direction most of the time so liquid
  // runs along floors and spreads out instead of jittering in place
  const momentum = mom[index];
  const first = momentum !== 0 && Math.random() < 0.85 ? momentum : Math.random() < 0.5 ? -1 : 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    const dx = attempt === 0 ? first : -first;
    const nx = x + dx;
    if (nx < 0 || nx >= cols) continue;
    const target = index + dx;
    if (cells[target] === EMPTY) {
      swapCells(index, target);
      mom[target] = dx;
      return;
    }
  }
  mom[index] = 0;
}

function step() {
  for (let y = rows - 1; y >= 0; y--) {
    const rowStart = y * cols;
    const leftToRight = Math.random() < 0.5;
    for (let i = 0; i < cols; i++) {
      const x = leftToRight ? i : cols - 1 - i;
      const index = rowStart + x;
      const kind = cells[index];
      if (kind === EMPTY || kind === WALL) continue;
      if (kind === SAND) fallSand(index, x, y);
      else flowLiquid(index, x, y, kind === ACID);
    }
  }
}

/* ---------------- starter scene ---------------- */

function seedScene() {
  const floorTop = rows - 6;
  fillRect(0, floorTop, cols, 6, WALL);

  const wallTop = Math.floor(rows * 0.42);
  const leftWall = Math.floor(cols * 0.16);
  const rightWall = Math.floor(cols * 0.84);
  fillRect(leftWall, wallTop, 2, floorTop - wallTop, WALL);
  fillRect(rightWall - 2, wallTop, 2, floorTop - wallTop, WALL);

  const innerLeft = leftWall + 2;
  const innerRight = rightWall - 2;
  const middle = Math.floor((innerLeft + innerRight) / 2);
  const height = floorTop - wallTop;

  for (let y = wallTop; y < floorTop; y++) {
    const depth = (floorTop - y) / height;
    const row = y * cols;
    for (let x = innerLeft; x < innerRight; x++) {
      if (x < middle && depth < 0.66) setCell(row + x, SAND);
      else if (x >= middle && depth < 0.44) setCell(row + x, WATER);
    }
  }
}

// __PART3__

