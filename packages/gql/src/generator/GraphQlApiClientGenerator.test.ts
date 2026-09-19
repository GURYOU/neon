import { ErrorPrefix } from "@the-neon/core";
import GraphQlApiClientGenerator from "./GraphQlApiClientGenerator";

jest.mock("fs", () => ({
  existsSync: jest.fn(),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

const mockFs = jest.requireMock("fs");

const writtenFile = (pattern: RegExp): string => {
  const call = mockFs.writeFileSync.mock.calls.find(([target]: [string]) =>
    pattern.test(target),
  );
  if (!call) {
    throw new Error(`no file written matching ${pattern}`);
  }
  return call[1];
};

// Evaluates the emitted gqlClient source in isolation: the two ESM imports are
// swapped for injected stubs so the generated module can run under Jest/CJS.
const loadGeneratedClient = (
  source: string,
  { amplifyEndpoint, idToken }: { amplifyEndpoint?: string; idToken?: string },
) => {
  const body = source
    .split("\n")
    .filter((line) => !line.startsWith("import "))
    .join("\n")
    .replace(/export const /g, "const ");

  const fetchMock = jest.fn().mockResolvedValue({
    json: async () => ({ data: { noop: null } }),
  });
  const Amplify = {
    getConfig: () => ({ API: { GraphQL: { endpoint: amplifyEndpoint } } }),
  };
  const fetchAuthSession = async () => ({
    tokens: idToken ? { idToken: { toString: () => idToken } } : undefined,
  });

  const factory = new Function(
    "Amplify",
    "fetchAuthSession",
    "fetch",
    `${body}\nreturn { apiCall, configureClient };`,
  );

  return { ...factory(Amplify, fetchAuthSession, fetchMock), fetchMock };
};

describe("GraphQlApiClientGenerator", () => {
  describe("createReqFields", () => {
    it("returns empty string when responseType is JSON", () => {
      const types = new Map();
      const result = GraphQlApiClientGenerator.createReqFields(
        { responseType: "JSON", params: [] },
        types,
      );
      expect(result).toBe("");
    });

    it("returns scalar field names for user-defined type", () => {
      const types = new Map();
      types.set("User", {
        members: [
          { name: "id", scalar: true },
          { name: "email", scalar: true },
          { name: "createdAt", scalar: false },
        ],
      });
      const result = GraphQlApiClientGenerator.createReqFields(
        { responseType: "User", params: [] },
        types,
      );
      expect(result).toContain("id");
      expect(result).toContain("email");
      expect(result).not.toContain("createdAt");
    });

    it("handles array response type by stripping brackets", () => {
      const types = new Map();
      types.set("User", {
        members: [{ name: "id", scalar: true }],
      });
      const result = GraphQlApiClientGenerator.createReqFields(
        { responseType: "[User]", params: [] },
        types,
      );
      expect(result).toContain("id");
    });

    it("returns empty string when type is not found in types map", () => {
      const types = new Map();
      const result = GraphQlApiClientGenerator.createReqFields(
        { responseType: "UnknownType", params: [] },
        types,
      );
      expect(result).toBe("");
    });
  });

  describe("createClientApis", () => {
    it("generates API methods for queries and mutations", () => {
      const queries = [
        {
          instance: "UserApi",
          methodName: "listUsers",
          params: [{ paramName: "limit", paramType: "Int", optional: false }],
          responseType: "JSON",
        },
      ];
      const mutations = [
        {
          instance: "UserApi",
          methodName: "createUser",
          params: [{ paramName: "name", paramType: "String", optional: true }],
          responseType: "JSON",
        },
      ];
      const types = new Map();

      const apis = GraphQlApiClientGenerator.createClientApis(
        queries,
        mutations,
        types,
      );

      expect(apis.size).toBe(1);
      expect(apis.get("UserApi")).toContain("listUsers");
      expect(apis.get("UserApi")).toContain("createUser");
      expect(apis.get("UserApi")).toContain("LISTUSERS_QUERY");
      expect(apis.get("UserApi")).toContain("mutation");
    });

    it("separates instances into separate API files", () => {
      const queries = [
        {
          instance: "UserApi",
          methodName: "getUser",
          params: [],
          responseType: "JSON",
        },
        {
          instance: "PostApi",
          methodName: "getPost",
          params: [],
          responseType: "JSON",
        },
      ];
      const types = new Map();

      const apis = GraphQlApiClientGenerator.createClientApis(
        queries,
        [],
        types,
      );

      expect(apis.size).toBe(2);
      expect(apis.has("UserApi")).toBe(true);
      expect(apis.has("PostApi")).toBe(true);
    });

    it("generates gql client import statement", () => {
      const queries = [
        {
          instance: "UserApi",
          methodName: "getUser",
          params: [],
          responseType: "JSON",
        },
      ];
      const apis = GraphQlApiClientGenerator.createClientApis(
        queries,
        [],
        new Map(),
      );
      const apiContent = apis.get("UserApi");
      expect(apiContent).toContain("import { apiCall } from './gqlClient';");
    });
  });

  describe("generateFiles", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it("writes gqlClient.js when clientPath provided", () => {
      GraphQlApiClientGenerator.generateFiles(
        [],
        [],
        new Map(),
        "/output",
        "/client",
      );

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/gqlClient\.js$/),
        expect.stringContaining("Amplify"),
      );
    });

    it("writes individual API files per instance", () => {
      const queries = [
        {
          instance: "UserApi",
          methodName: "listUsers",
          params: [],
          responseType: "JSON",
        },
      ];

      GraphQlApiClientGenerator.generateFiles(
        queries,
        [],
        new Map(),
        "/output",
        "/client",
      );

      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        expect.stringMatching(/UserApi\.js$/),
        expect.any(String),
      );
    });

    it("does not write any files when clientPath is not provided", () => {
      GraphQlApiClientGenerator.generateFiles([], [], new Map(), "/output");

      expect(mockFs.writeFileSync).not.toHaveBeenCalled();
    });

    it("creates directory when clientPath does not exist", () => {
      mockFs.existsSync.mockReturnValue(false);

      GraphQlApiClientGenerator.generateFiles(
        [],
        [],
        new Map(),
        "/output",
        "/client",
      );

      expect(mockFs.mkdirSync).toHaveBeenCalled();
    });

    it("skips directory creation when clientPath already exists", () => {
      mockFs.existsSync.mockReturnValue(true);

      GraphQlApiClientGenerator.generateFiles(
        [],
        [],
        new Map(),
        "/output",
        "/client",
      );

      expect(mockFs.mkdirSync).not.toHaveBeenCalled();
    });

    it("writes an index.js re-exporting every generated module", () => {
      const queries = [
        {
          instance: "UserApi",
          methodName: "listUsers",
          params: [],
          responseType: "JSON",
        },
        {
          instance: "OrderApi",
          methodName: "listOrders",
          params: [],
          responseType: "JSON",
        },
      ];

      GraphQlApiClientGenerator.generateFiles(
        queries,
        [],
        new Map(),
        "/output",
        "/client",
      );

      expect(writtenFile(/index\.js$/)).toBe(
        [
          "export * from './OrderApi';",
          "export * from './UserApi';",
          "export * from './gqlClient';",
          "",
        ].join("\n"),
      );
    });

    it("sorts the index.js exports so regeneration is deterministic", () => {
      const queries = ["Zeta", "Alpha", "Mid"].map((instance) => ({
        instance: `${instance}Api`,
        methodName: "list",
        params: [],
        responseType: "JSON",
      }));

      GraphQlApiClientGenerator.generateFiles(
        queries,
        [],
        new Map(),
        "/output",
        "/client",
      );

      const lines = writtenFile(/index\.js$/)
        .trim()
        .split("\n");
      expect(lines).toEqual([...lines].sort());
    });
  });

  // The generator inlines its own resolved copy of the ErrorPrefix enum into
  // every client it emits, so a stale @the-neon/core silently drops constants
  // from the generated file. The expectation is derived from the imported enum
  // rather than a fixed list, so it keeps holding when a key is added upstream.
  describe("emitted ErrorPrefix", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    const emittedClient = () => {
      GraphQlApiClientGenerator.generateFiles(
        [],
        [],
        new Map(),
        "/output",
        "/client",
      );
      return writtenFile(/gqlClient\.js$/);
    };

    it.each(Object.entries(ErrorPrefix))(
      "inlines %s with its value",
      (key, value) => {
        expect(emittedClient()).toContain(`${key}: '${value}',`);
      },
    );

    // The two assertions above derive both sides from the same import, so they
    // hold even when that import is a stale @the-neon/core. This one anchors the
    // resolution itself: the generator must inline THIS repo's core, not
    // whatever the registry happens to supply.
    it("resolves the workspace copy of @the-neon/core", () => {
      const resolved = require("@the-neon/core/package.json").version;
      const workspace = require("../../../core/package.json").version;

      expect(resolved).toBe(workspace);
    });

    it("inlines every key of the enum and no others", () => {
      const block = emittedClient().match(
        /export const ErrorPrefix = \{\n([\s\S]*?)\n\};/,
      );
      if (!block) {
        throw new Error("no ErrorPrefix block in the emitted client");
      }

      const emitted = block[1]
        .split("\n")
        .map((line) => line.trim().split(":")[0])
        .filter(Boolean);

      expect(emitted.sort()).toEqual(Object.keys(ErrorPrefix).sort());
    });
  });

  describe("generated client endpoint resolution", () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    const generateClient = () => {
      GraphQlApiClientGenerator.generateFiles(
        [],
        [],
        new Map(),
        "/output",
        "/client",
      );
      return writtenFile(/gqlClient\.js$/);
    };

    it("issues an unchanged request when configureClient is never called", async () => {
      const { apiCall, fetchMock } = loadGeneratedClient(generateClient(), {
        amplifyEndpoint: "https://amplify.example/graphql",
        idToken: "id-token",
      });

      await apiCall({
        query: "query { noop }",
        variables: { id: 1 },
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://amplify.example/graphql",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "id-token",
          },
          body: JSON.stringify({
            query: "query { noop }",
            variables: { id: 1 },
          }),
        },
      );
    });

    it("uses the injected endpoint once configureClient has been called", async () => {
      const { apiCall, configureClient, fetchMock } = loadGeneratedClient(
        generateClient(),
        { amplifyEndpoint: "https://amplify.example/graphql" },
      );

      configureClient({ endpoint: "https://training.example/graphql" });
      await apiCall({ query: "query { noop }" });

      expect(fetchMock).toHaveBeenCalledWith(
        "https://training.example/graphql",
        expect.any(Object),
      );
    });

    it("resolves the endpoint per call, so configuring after import applies", async () => {
      const { apiCall, configureClient, fetchMock } = loadGeneratedClient(
        generateClient(),
        { amplifyEndpoint: "https://amplify.example/graphql" },
      );

      await apiCall({ query: "query { noop }" });
      configureClient({ endpoint: "https://training.example/graphql" });
      await apiCall({ query: "query { noop }" });

      expect(fetchMock.mock.calls[0][0]).toBe(
        "https://amplify.example/graphql",
      );
      expect(fetchMock.mock.calls[1][0]).toBe(
        "https://training.example/graphql",
      );
    });

    it("keeps configuration separate per generated client module", async () => {
      const source = generateClient();
      const proxy = loadGeneratedClient(source, {
        amplifyEndpoint: "https://amplify.example/graphql",
      });
      const training = loadGeneratedClient(source, {
        amplifyEndpoint: "https://amplify.example/graphql",
      });

      training.configureClient({
        endpoint: "https://training.example/graphql",
      });
      await proxy.apiCall({ query: "query { noop }" });
      await training.apiCall({ query: "query { noop }" });

      expect(proxy.fetchMock.mock.calls[0][0]).toBe(
        "https://amplify.example/graphql",
      );
      expect(training.fetchMock.mock.calls[0][0]).toBe(
        "https://training.example/graphql",
      );
    });
  });
});
