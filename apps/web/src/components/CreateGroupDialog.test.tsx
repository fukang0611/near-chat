import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { User } from "../types";
import { CreateGroupDialog } from "./CreateGroupDialog";

const members: User[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    username: "alice",
    displayName: "林小满",
    avatarColor: "#E76F88",
    avatarUrl: null,
    online: true,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    username: "bob",
    displayName: "周远",
    avatarColor: "#2FA98C",
    avatarUrl: null,
    online: true,
  },
];

describe("CreateGroupDialog flash room", () => {
  it("选择闪聊时把有效期随成员一起提交", async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    const before = Date.now();
    render(<CreateGroupDialog users={members} onClose={vi.fn()} onCreate={onCreate} />);
    const user = userEvent.setup();

    await user.type(screen.getByPlaceholderText("例如：产品讨论组"), "临时评审");
    await user.click(screen.getByRole("button", { name: /闪聊房间/ }));
    await user.click(screen.getByRole("button", { name: "30 分钟" }));
    await user.click(screen.getByRole("button", { name: /林小满/ }));
    await user.click(screen.getByRole("button", { name: /周远/ }));
    await user.click(screen.getByRole("button", { name: "发起闪聊" }));

    expect(onCreate).toHaveBeenCalledOnce();
    expect(onCreate.mock.calls[0][0]).toBe("临时评审");
    expect(onCreate.mock.calls[0][1]).toEqual(members.map((member) => member.id));
    const expiry = new Date(onCreate.mock.calls[0][2]).getTime();
    expect(expiry - before).toBeGreaterThanOrEqual(29 * 60_000);
    expect(expiry - before).toBeLessThanOrEqual(31 * 60_000);
  });
});
