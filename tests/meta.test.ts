import { describe, expect, it } from "vitest";
import { MetaStore } from "../src/store/meta.ts";

describe("MetaStore.truncateMessagesFrom", () => {
  it("删除目标消息及其后所有消息，只影响该会话", () => {
    const meta = new MetaStore(":memory:");
    const uid = meta.createUser("tuser", "x", "analyst").id;
    const s1 = meta.createChatSession(uid, "会话一");
    const s2 = meta.createChatSession(uid, "会话二");
    meta.addMessage(s1, "user", "q1");
    const a1 = meta.addMessage(s1, "assistant", "a1");
    meta.addMessage(s1, "user", "q2");
    meta.addMessage(s2, "user", "其他会话");

    const removed = meta.truncateMessagesFrom(s1, a1);
    expect(removed).toBe(2);
    const left = meta.listMessages(s1).map((m) => m.content);
    expect(left).toEqual(["q1"]);
    expect(meta.listMessages(s2)).toHaveLength(1);
    meta.close();
  });
});
