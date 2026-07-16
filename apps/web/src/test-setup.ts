import "@testing-library/jest-dom";

// jsdom не реализует scrollIntoView (используется формой брони для
// автоскролла к невалидному шагу) — глушим, чтобы клики в тестах не падали.
if (typeof Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
