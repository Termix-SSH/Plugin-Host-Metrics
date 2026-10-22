import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  FirewallManagement,
  ManagedRuleSpec,
} from "../../../../src/shared/firewall-management.js";
import en from "../../../../locales/en.json";
const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  confirm: vi.fn(),
  canEdit: true,
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../../../../src/frontend/host-metrics-api", () => ({
  useHostMetricsApi: () => ({ managerGet: mocks.get, managerPost: mocks.post }),
}));
vi.mock("../../../../src/frontend/cards/managers/useCanEditHost", () => ({
  useCanEditHost: () => mocks.canEdit,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.split(".").reduce((obj: any, k) => obj?.[k], en) ?? key,
  }),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (original) => ({
  ...(await original<object>()),
  useConfirm: () => mocks.confirm,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error },
}));
import { FirewallManagerCard } from "../../../../src/frontend/cards/managers/FirewallManagerCard";
const spec: ManagedRuleSpec = {
  family: "ipv6",
  direction: "in",
  action: "allow",
  protocol: "any",
  source: "::/0",
  destination: "::/0",
  port: "8765",
  sourcePort: "any",
  comment: "preserve me",
};
const data = (
  type: FirewallManagement["type"] = "ufw",
  hostId = 7,
): FirewallManagement => ({
  hostId,
  type,
  status: "active",
  snapshot: `snapshot-${hostId}`,
  chains: [],
  managedRules: [
    {
      id: "row-1",
      description:
        "ipv6 allow in any from ::/0:any to ::/0:8765 comment preserve me",
      spec,
      chain: "INPUT",
      target: "ALLOW",
      protocol: "any",
      source: "::/0",
      destination: "::/0",
      dport: "8765",
    },
  ],
  policies: [
    {
      id: "INPUT",
      chain: "INPUT",
      family: "IPv4 + IPv6",
      value: "deny",
      choices: ["allow", "deny", "reject"],
    },
  ],
});
const mount = async (type: FirewallManagement["type"] = "ufw") => {
  mocks.get.mockResolvedValue(data(type));
  const view = render(<FirewallManagerCard hostId={7} />);
  await screen.findByRole("button", {
    name: "Edit: " + data().managedRules[0].description,
  });
  return view;
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.canEdit = true;
  mocks.confirm.mockResolvedValue(true);
  mocks.post.mockResolvedValue({ success: true, output: "applied" });
});
afterEach(cleanup);
describe("firewall manager", () => {
  it("opens an inline editor and restores focus when dismissed without writing", async () => {
    const view = await mount();
    const trigger = screen.getByRole("button", { name: "Edit" });
    trigger.focus();
    fireEvent.click(trigger);
    const panel = screen.getByRole("region", { name: "Edit" });
    expect(view.container).toContainElement(panel);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(within(panel).getByRole("group", { name: "Edit" })).toHaveFocus();
    expect(within(panel).getByText("Host 7 · ufw")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Edit" })).toBeNull();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("region", { name: "Edit" })).toBeNull();
    expect(trigger).toHaveFocus();
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("disables the inline draft during confirmation and retains it when cancelled", async () => {
    await mount();
    let finish!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Destination port (or any)"), {
      target: { value: "8766" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("group", { name: "Edit" })).toBeDisabled();
    await act(async () => finish(false));
    expect(screen.getByRole("region", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Edit" })).not.toBeDisabled();
    expect(screen.getByLabelText("Destination port (or any)")).toHaveValue(
      "8766",
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("retains compact rule columns and visible family/direction metadata", async () => {
    await mount();
    const row = screen.getByRole("button", { name: /^Edit: ipv6/ });
    for (const value of ["ALLOW", "any", "8765", "::/0", "ipv6", "in"])
      expect(within(row).getByText(value, { exact: true })).toBeInTheDocument();
    expect(row).toHaveAttribute("title", data().managedRules[0].description);
    expect(row.textContent).not.toContain("from");
    expect(row.querySelector("button")).toBeNull();
  });
  it("uses labelled themed icons beside the rule without a full-width breakpoint", async () => {
    await mount();
    const row = screen.getByRole("button", { name: /^Edit: ipv6/ });
    expect(row).toHaveClass("flex-1", "basis-0");
    expect(row).not.toHaveClass("basis-full");
    for (const name of ["Edit", "Delete"]) {
      const action = screen.getByRole("button", { name });
      expect(action).toHaveAttribute("title", name);
      expect(action).toHaveClass("text-accent-brand");
      expect(action.textContent).toBe("");
      expect(action.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
      expect(row.parentElement).toContainElement(action);
    }
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("group", { name: "Edit" })).toBeInTheDocument();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("locks discovered profile protocol/ports and preserves the profile in a source edit", async () => {
    const value = data();
    value.managedRules[0].spec = {
      ...spec,
      profile: "OpenSSH",
      protocol: "tcp",
      port: "22",
    };
    mocks.get.mockResolvedValue(value);
    render(<FirewallManagerCard hostId={7} />);
    const row = await screen.findByRole("button", { name: /^Edit:/ });
    expect(within(row).getByText("OpenSSH")).toBeInTheDocument();
    fireEvent.click(row);
    expect(screen.getByRole("group", { name: "Edit" })).toHaveFocus();
    expect(screen.getByLabelText("Destination port (or any)")).toHaveAttribute(
      "readonly",
    );
    expect(screen.getByLabelText("Source port (or any)")).toHaveAttribute(
      "readonly",
    );
    expect(screen.getByRole("button", { name: "tcp" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Source address/CIDR"), {
      target: { value: "2001:db8::/64" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        7,
        "firewall",
        expect.objectContaining({
          spec: expect.objectContaining({
            profile: "OpenSSH",
            protocol: "tcp",
            port: "22",
            source: "2001:db8::/64",
          }),
        }),
        "manage",
      ),
    );
  });
  it("does not submit a frozen confirmation once a refresh changes its snapshot", async () => {
    await mount();
    let finish!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    mocks.get.mockResolvedValue({ ...data(), snapshot: "new-snapshot" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await act(async () => {
      finish(true);
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it("opens a full-field editor from the row button with preserved family/direction/comment", async () => {
    await mount();
    const row = screen.getByRole("button", { name: /^Edit: ipv6/ });
    expect(row.tagName).toBe("BUTTON");
    expect(row.querySelector("button")).toBeNull();
    fireEvent.click(row);
    expect(screen.getByLabelText("Source address/CIDR")).toHaveValue("::/0");
    expect(screen.getByLabelText("Destination address/CIDR")).toHaveValue(
      "::/0",
    );
    expect(screen.getByLabelText("Destination port (or any)")).toHaveValue(
      "8765",
    );
    expect(screen.getByLabelText("Source port (or any)")).toHaveValue("any");
    expect(
      screen.getByText(
        /Preserved family, direction, profile and comment: ipv6/,
      ),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Destination port (or any)"), {
      target: { value: "8766" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        7,
        "firewall",
        {
          op: "edit",
          id: "row-1",
          snapshot: "snapshot-7",
          spec: { ...spec, port: "8766" },
        },
        "manage",
      ),
    );
    const confirmation = mocks.confirm.mock.calls[0][0];
    const text = render(confirmation.description);
    expect(text.container.textContent).toContain("Host 7 · ufw");
    expect(text.container.textContent).toContain("Old:");
    expect(text.container.textContent).toContain("New:");
    expect(text.container.textContent).toContain("8765");
    expect(text.container.textContent).toContain("8766");
    expect(text.container.textContent).toContain("NOT atomic");
    expect(text.container.textContent).toContain("SSH");
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
  });
  it("cancels deletion without POST, then confirms exact numbered identity and refreshes", async () => {
    await mount();
    mocks.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(1));
    expect(mocks.post).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        7,
        "firewall",
        { op: "delete", id: "row-1", snapshot: "snapshot-7" },
        "manage",
      ),
    );
    const text = render(mocks.confirm.mock.calls[1][0].description).container
      .textContent;
    expect(text).toContain("Delete exactly:");
    expect(text).toContain(data().managedRules[0].description);
  });
  it.each(["reject", "failure"])(
    "refreshes after %s, without retrying the mutation",
    async (mode) => {
      await mount();
      if (mode === "reject")
        mocks.post.mockRejectedValue(Error("stale snapshot"));
      else mocks.post.mockResolvedValue({ success: false, output: "partial" });
      fireEvent.click(screen.getByRole("button", { name: "Delete" }));
      await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
      expect(mocks.post).toHaveBeenCalledTimes(1);
      expect(mocks.error).toHaveBeenCalled();
    },
  );
  it("edits the default INPUT policy with explicit both-family confirmation", async () => {
    await mount();
    fireEvent.click(
      screen.getByRole("button", { name: /INPUT · IPv4 \+ IPv6/ }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("region", { name: "Edit default policy" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Policy" }));
    fireEvent.click(
      within(screen.getByRole("listbox")).getByRole("option", {
        name: "allow",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        7,
        "firewall",
        { op: "policy", id: "INPUT", snapshot: "snapshot-7", value: "allow" },
        "manage",
      ),
    );
    expect(
      render(mocks.confirm.mock.calls[0][0].description).container.textContent,
    ).toContain("deny → allow");
  });
  it("hides mutation controls from connect-only users and disables unsupported rules", async () => {
    mocks.canEdit = false;
    await mount();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Edit: / })).toBeDisabled();
  });
  it("shows explicit read-only reasons without allowing row actions", async () => {
    const value = data();
    value.managedRules[0].spec = undefined;
    value.managedRules[0].readOnlyReason = "Profile groups preserved";
    mocks.get.mockResolvedValue(value);
    render(<FirewallManagerCard hostId={7} />);
    expect(
      await screen.findByText("Read-only: Profile groups preserved"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
  });
  it.each(["ufw", "iptables", "nftables"] as const)(
    "shows backend-specific persistence for %s",
    async (type) => {
      await mount(type);
      if (type === "ufw") {
        expect(
          screen.getByText(/UFW changes are persistent immediately/),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Persist rules" }),
        ).toBeNull();
      } else if (type === "iptables") {
        expect(
          screen.getByRole("button", { name: "Persist rules" }),
        ).toBeInTheDocument();
      } else {
        expect(
          screen.getByText(/does not overwrite nftables.conf/),
        ).toBeInTheDocument();
        expect(
          screen.queryByRole("button", { name: "Persist rules" }),
        ).toBeNull();
      }
    },
  );
  it("discards host editors and cannot submit an old confirmation after a host switch", async () => {
    const view = await mount();
    let finish!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    mocks.get.mockResolvedValue(data("ufw", 8));
    view.rerender(<FirewallManagerCard hostId={8} />);
    await act(async () => {
      finish(true);
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Source address/CIDR")).toBeNull();
  });
  it("ignores a slow previous host response", async () => {
    let finish!: (value: FirewallManagement) => void;
    mocks.get
      .mockReturnValueOnce(
        new Promise<FirewallManagement>((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue(data("ufw", 8));
    const view = render(<FirewallManagerCard hostId={7} />);
    view.rerender(<FirewallManagerCard hostId={8} />);
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await act(async () => {
      finish(data());
    });
    expect(screen.getByRole("button", { name: /^Edit: / })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        8,
        "firewall",
        expect.objectContaining({ snapshot: "snapshot-8" }),
        "manage",
      ),
    );
  });
});
