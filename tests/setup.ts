import { vi } from "vitest";

Object.defineProperty(HTMLElement.prototype, "scrollTo", { value: vi.fn(), configurable: true });
Object.defineProperty(HTMLElement.prototype, "scrollBy", { value: vi.fn(), configurable: true });
vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
