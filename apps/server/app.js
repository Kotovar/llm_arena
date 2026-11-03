"use strict";

const scene = document.getElementById("riverScene");
const toggle = document.getElementById("motionToggle");
const toggleText = document.getElementById("toggleText");
const toggleIcon = document.getElementById("toggleIcon");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let paused = false;

function setPaused(nextPaused) {
  paused = nextPaused;
  document.body.classList.toggle("is-paused", paused);
  toggle.setAttribute("aria-pressed", String(paused));
  toggle.setAttribute("aria-label", paused ? "Play animation" : "Pause animation");
  toggleText.textContent = paused ? "Play scene" : "Pause scene";
  toggleIcon.setAttribute("d", paused ? "M6 4l10 6-10 6Z" : "M6 4h3v12H6zm5 0h3v12h-3z");

  if (paused) scene.pauseAnimations();
  else scene.unpauseAnimations();
}

toggle.addEventListener("click", () => setPaused(!paused));

if (reducedMotion.matches) setPaused(true);
reducedMotion.addEventListener("change", (event) => setPaused(event.matches));
