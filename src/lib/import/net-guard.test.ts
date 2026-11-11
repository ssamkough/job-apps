import { describe, expect, it } from "vitest";
import { isBlockedIp } from "./net-guard";

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "10.0.0.5",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fe80::1%en0",
    "fc00::1",
    "fd12:3456::1",
    "ff02::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:7f00:1", // same, hex form
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1", // NAT64 to 10.0.0.1
    "2002:7f00:1::", // 6to4 to 127.0.0.1
    "2001:db8::1",
    "not an ip",
    "",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "172.15.0.1", // just outside 172.16/12
    "172.32.0.1",
    "100.63.255.255", // just outside CGNAT
    "100.128.0.1",
    "169.253.1.1",
    "2606:4700:4700::1111",
    "2001:4860:4860::8888",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808", // NAT64 to 8.8.8.8
  ])("allows %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });
});
