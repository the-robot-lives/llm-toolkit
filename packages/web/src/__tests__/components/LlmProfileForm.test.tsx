import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { LlmProfileForm } from "../../components/LlmProfileForm.tsx";
import { testLlmProfile, type LlmProfile } from "../../hooks/useApi.ts";

vi.mock("../../hooks/useApi.ts", () => ({ testLlmProfile: vi.fn() }));
const draft: LlmProfile = { id: "draft", name: "Unsaved", provider: "alibaba", model: "", apiKey: "draft-key", local: false,
  baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1" };
function Editor() {
  const [profile, setProfile] = useState(draft);
  return <LlmProfileForm profile={profile} onChange={(updates) => setProfile((current) => ({ ...current, ...updates }))} />;
}
beforeEach(() => vi.clearAllMocks());

describe("LLM profile draft workflow", () => {
  test("offers Alibaba plan presets and fetches selector options before saving", async () => {
    vi.mocked(testLlmProfile).mockResolvedValue({ ok: true, models: ["qwen-max", "qwen-flash"] });
    render(<Editor />);
    expect(screen.getByRole("combobox", { name: "Provider" })).toHaveValue("alibaba");
    fireEvent.change(screen.getByLabelText("API Key"), { target: { value: "edited-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Test & fetch models" }));
    await screen.findByText("Connected — 2 models fetched.");
    expect(testLlmProfile).toHaveBeenCalledWith(expect.objectContaining({ id: "draft", apiKey: "edited-key", model: "" }));
    const model = screen.getByRole("combobox", { name: "Model" });
    const options = document.getElementById(model.getAttribute("list")!);
    expect(options?.querySelectorAll("option")).toHaveLength(2);
    fireEvent.change(model, { target: { value: "qwen-max" } });
    expect(model).toHaveValue("qwen-max");
    fireEvent.change(screen.getByLabelText("Alibaba endpoint preset"), { target: { value: "https://coding-intl.dashscope.aliyuncs.com/v1" } });
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://coding-intl.dashscope.aliyuncs.com/v1");
    await waitFor(() => expect(options?.querySelectorAll("option")).toHaveLength(0));
  });

  test("ignores a response from the previous connection and allows manual model IDs", async () => {
    let resolve!: (value: { ok: boolean; models: string[] }) => void;
    vi.mocked(testLlmProfile).mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<Editor />);
    fireEvent.click(screen.getByRole("button", { name: "Test & fetch models" }));
    fireEvent.change(screen.getByLabelText("Base URL"), { target: { value: "https://different.example/v1" } });
    await act(async () => resolve({ ok: true, models: ["stale-model"] }));
    expect(screen.queryByText(/Connected/)).not.toBeInTheDocument();
    const model = screen.getByRole("combobox", { name: "Model" });
    fireEvent.change(model, { target: { value: "custom-model" } });
    expect(model).toHaveValue("custom-model");
  });
});
