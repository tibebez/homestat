import { expect, test } from "bun:test";
import {
  getAllServices,
  getDistinctGroupNames,
  getServiceGroupLabel,
  getServicesByGroup,
  getServicesForView,
  getUngroupedServices,
  sortServicesBookmarkedFirst,
  type Service,
  type ServiceListView,
} from "../src/index.ts";

const sampleServices: Service[] = [
  { name: "A", url: "http://localhost:3000", group: "Media" },
  { name: "B", url: "http://localhost:3001", group: null },
  { name: "C", url: "http://localhost:3002", group: "Monitoring" },
  { name: "D", url: "http://localhost:3003", group: "Media" },
  { name: "E", url: "http://localhost:3004" },
  { name: "F", url: "http://localhost:3005", group: "" },
];

test("returns all services without filtering", () => {
  const all = getAllServices(sampleServices);

  expect(all.length).toBe(sampleServices.length);
  expect(all).toEqual(sampleServices);
  expect(all).not.toBe(sampleServices);
});

test("returns distinct group names in stable first-seen order", () => {
  expect(getDistinctGroupNames(sampleServices)).toEqual(["Media", "Monitoring"]);
});

test("returns services in selected group only", () => {
  const media = getServicesByGroup(sampleServices, "Media");
  expect(media.map((service) => service.name)).toEqual(["A", "D"]);
});

test("normalizes whitespace when collecting distinct group names", () => {
  const services: Service[] = [
    { name: "A", url: "http://localhost:1", group: "Media" },
    { name: "B", url: "http://localhost:2", group: " Media " },
    { name: "C", url: "http://localhost:3", group: "Monitoring" },
  ];

  expect(getDistinctGroupNames(services)).toEqual(["Media", "Monitoring"]);
});

test("normalizes whitespace when filtering services by group", () => {
  const services: Service[] = [
    { name: "A", url: "http://localhost:1", group: "Media" },
    { name: "B", url: "http://localhost:2", group: " Media " },
    { name: "C", url: "http://localhost:3", group: "Monitoring" },
  ];

  const media = getServicesByGroup(services, "Media ");
  expect(media.map((service) => service.name)).toEqual(["A", "B"]);
});

test("returns ungrouped services (undefined, null, blank)", () => {
  const ungrouped = getUngroupedServices(sampleServices);
  expect(ungrouped.map((service) => service.name)).toEqual(["B", "E", "F"]);
});

test("returns group label for grouped services", () => {
  expect(getServiceGroupLabel(sampleServices[0])).toBe("Media");
});

test("returns placeholder for ungrouped services", () => {
  expect(getServiceGroupLabel(sampleServices[1])).toBe("Ungrouped");
  expect(getServiceGroupLabel(sampleServices[4], "No Group")).toBe("No Group");
});

test("sorts bookmarked services first by bookmarked timestamp descending", () => {
  const services: Service[] = [
    { name: "first", url: "http://localhost:1", bookmarked: false },
    { name: "older bookmark", url: "http://localhost:2", bookmarked: true, bookmarkedAt: 100 },
    { name: "newer bookmark", url: "http://localhost:3", bookmarked: true, bookmarkedAt: 500 },
    { name: "legacy bookmark", url: "http://localhost:4", bookmarked: true },
    { name: "second", url: "http://localhost:5", bookmarked: false },
  ];

  const sorted = sortServicesBookmarkedFirst(services);

  expect(sorted.map((service) => service.name)).toEqual([
    "newer bookmark",
    "older bookmark",
    "legacy bookmark",
    "first",
    "second",
  ]);
});

test("group view ordering can be composed with bookmark-first sorting", () => {
  const services: Service[] = [
    { name: "A", url: "http://localhost:1", group: "Media", bookmarked: false },
    { name: "B", url: "http://localhost:2", group: "Media", bookmarked: true, bookmarkedAt: 10 },
    { name: "C", url: "http://localhost:3", group: "Other", bookmarked: true, bookmarkedAt: 999 },
    { name: "D", url: "http://localhost:4", group: "Media", bookmarked: true, bookmarkedAt: 20 },
  ];

  const mediaOrdered = sortServicesBookmarkedFirst(getServicesByGroup(services, "Media"));
  expect(mediaOrdered.map((service) => service.name)).toEqual(["D", "B", "A"]);
});

test("getServicesForView sorts All Services bookmark-first", () => {
  const services: Service[] = [
    { name: "A", url: "http://localhost:1", bookmarked: false },
    { name: "B", url: "http://localhost:2", bookmarked: true, bookmarkedAt: 10 },
    { name: "C", url: "http://localhost:3", bookmarked: true, bookmarkedAt: 20 },
  ];

  const view: ServiceListView = { kind: "all" };
  const ordered = getServicesForView(services, view);
  expect(ordered.map((service) => service.name)).toEqual(["C", "B", "A"]);
});

test("getServicesForView sorts Group view bookmark-first within selected group", () => {
  const services: Service[] = [
    { name: "A", url: "http://localhost:1", group: "Media", bookmarked: false },
    { name: "B", url: "http://localhost:2", group: "Media", bookmarked: true, bookmarkedAt: 10 },
    { name: "C", url: "http://localhost:3", group: "Other", bookmarked: true, bookmarkedAt: 999 },
    { name: "D", url: "http://localhost:4", group: "Media", bookmarked: true, bookmarkedAt: 20 },
  ];

  const view: ServiceListView = { kind: "group", groupName: "Media" };
  const ordered = getServicesForView(services, view);
  expect(ordered.map((service) => service.name)).toEqual(["D", "B", "A"]);
});
