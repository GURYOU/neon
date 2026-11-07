/*eslint @typescript-eslint/no-explicit-any: "off"*/
import PostgresDB from "./index";

// Ported from guryou-mono api/proxy/src/tests/neonPgPool.test.ts: a query must
// hold its client until it resolves, concurrent queries must not share a client
// outside a transaction, a transaction must hold one client and release it even
// on failure, and two connection strings must get two pools.
type FakeClient = {
  id: number;
  query: jest.Mock;
  release: jest.Mock;
  releasedBeforeDone: boolean;
};

const pools: {
  connectionString: string;
  options: any;
  clients: FakeClient[];
}[] = [];

jest.mock("pg", () => ({
  Pool: class {
    clients: FakeClient[] = [];
    constructor(public options: any) {
      pools.push({
        connectionString: options.connectionString,
        options,
        clients: this.clients,
      });
    }
    on() {}
    async connect() {
      const client: FakeClient = {
        id: this.clients.length,
        releasedBeforeDone: false,
        query: jest.fn(
          (query: string, args: any[]) =>
            new Promise((resolve, reject) =>
              setTimeout(() => {
                client.releasedBeforeDone =
                  client.release.mock.calls.length > 0;
                if (query.includes("FAIL")) {
                  reject(new Error(`boom: ${query}`));
                } else {
                  resolve({ rowCount: 1, rows: [{ query, args }] });
                }
              }, 5),
            ),
        ),
        release: jest.fn(),
      };
      this.clients.push(client);
      return client;
    }
    async query(sql: string, args: any[]) {
      const client = await this.connect();
      try {
        return await client.query(sql, args);
      } finally {
        client.release();
      }
    }
  },
}));

const sqlOf = (client: FakeClient) =>
  client.query.mock.calls.map((c: any[]) => c[0]);

describe("PostgresDB", () => {
  let db = new PostgresDB("");
  beforeEach(() => {
    pools.length = 0;
    (PostgresDB as any).pools = {};
    PostgresDB.throwOnError = false;
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    db = new PostgresDB("");
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("getById without filter", async () => {
    const expQery = "SELECT * FROM test_table WHERE id in ($1)";
    const result = (await db.getById("test_table", "123")) as { args; query };
    expect(expQery).toBe(result.query.trim());
    expect(["123"]).toEqual(result.args);
  });

  it("getById with filter", async () => {
    const expQery =
      "SELECT * FROM test_table WHERE id in ($1) WHERE first_filter=$2";
    const result = (await db.getById("test_table", "123", {
      firstFilter: "234",
    })) as { args; query };

    expect(expQery).toBe(result.query.trim());
    expect(["123", "234"]).toEqual(result.args);
  });

  it("getByIds without filter", async () => {
    const expQery = "SELECT * FROM test_table WHERE id in ($1,$2)";
    const result = (await db.getByIds("test_table", ["123", "567"])) as {
      args;
      query;
    }[];

    expect(result[0].query.trim()).toBe(expQery);
    expect(["123", "567"]).toEqual(result[0].args);
  });

  it("getByIds with filter", async () => {
    const expQery =
      "SELECT * FROM test_table WHERE id in ($1,$2) WHERE first_filter=$3";
    const result = (await db.getByIds("test_table", ["123", "567"], {
      firstFilter: "234",
    })) as { args; query }[];

    expect(result[0].query).toBe(expQery);
    expect(["123", "567", "234"]).toEqual(result[0].args);
  });

  it("getByIds with filters", async () => {
    const expQery =
      "SELECT * FROM test_table WHERE id in ($1,$2) WHERE main_filter=$3 AND second_filter=$4";
    const result = (await db.getByIds("test_table", ["123", "567"], {
      mainFilter: "234",
      secondFilter: "888",
    })) as { args; query }[];

    expect(result[0].query).toBe(expQery);
    expect(["123", "567", "234", "888"]).toEqual(result[0].args);
  });

  describe("pooling", () => {
    it("concurrent queries each get their own client and keep it until done", async () => {
      const db = new PostgresDB("postgres://a");
      const [one, two] = await Promise.all([
        db.getOne("SELECT 1", []),
        db.getOne("SELECT 2", []),
      ]);
      expect(one).toEqual({ query: "SELECT 1", args: [] });
      expect(two).toEqual({ query: "SELECT 2", args: [] });
      const { clients, options } = pools[0];
      expect(clients).toHaveLength(2);
      expect(clients.every((c) => c.release.mock.calls.length === 1)).toBe(
        true,
      );
      expect(clients.every((c) => !c.releasedBeforeDone)).toBe(true);
      expect(options).toMatchObject({
        max: 4,
        idleTimeoutMillis: 60000,
        keepAlive: true,
        connectionTimeoutMillis: 2000,
      });
    });

    it("Promise.all of 5 on one instance uses 5 clients and leaks none", async () => {
      const db = new PostgresDB("postgres://a");
      const results = await db.getMany("SELECT x", []);
      expect(results).toHaveLength(1);
      const five = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => db.getOne(`SELECT ${n}`, [])),
      );
      expect(five.map((r: any) => r.query)).toEqual([
        "SELECT 1",
        "SELECT 2",
        "SELECT 3",
        "SELECT 4",
        "SELECT 5",
      ]);
      const { clients } = pools[0];
      expect(clients).toHaveLength(6);
      expect(new Set(clients.map((c) => c.id)).size).toBe(6);
      clients.forEach((c) => expect(c.release).toHaveBeenCalledTimes(1));
      expect(db._client).toBeUndefined();
    });

    it("two connection strings get two pools", async () => {
      await new PostgresDB("postgres://main").getOne("SELECT 1", []);
      await new PostgresDB("postgres://training").getOne("SELECT 1", []);
      await new PostgresDB("postgres://main").getOne("SELECT 1", []);
      expect(pools.map((p) => p.connectionString)).toEqual([
        "postgres://main",
        "postgres://training",
      ]);
    });
  });

  describe("transactions", () => {
    it("holds one client from start to commit, then releases it", async () => {
      const db = new PostgresDB("postgres://a");
      await db.start();
      await Promise.all([
        db.execute("UPDATE x", []),
        db.execute("UPDATE y", []),
      ]);
      await db.commit();
      const { clients } = pools[0];
      expect(clients).toHaveLength(1);
      expect(sqlOf(clients[0])).toEqual([
        "BEGIN",
        "UPDATE x",
        "UPDATE y",
        "COMMIT",
      ]);
      expect(clients[0].release).toHaveBeenCalledTimes(1);
      expect(db.transaction).toBe(false);
      await db.getOne("SELECT after", []);
      expect(pools[0].clients).toHaveLength(2);
    });

    it("rollback releases the client", async () => {
      const db = new PostgresDB("postgres://a");
      await db.start();
      await db.execute("UPDATE x", []);
      await db.rollback();
      const { clients } = pools[0];
      expect(clients).toHaveLength(1);
      expect(sqlOf(clients[0])).toEqual(["BEGIN", "UPDATE x", "ROLLBACK"]);
      expect(clients[0].release).toHaveBeenCalledTimes(1);
      expect(db._client).toBeUndefined();
    });

    it("releases the client when a query inside the transaction fails", async () => {
      const db = new PostgresDB("postgres://a");
      await db.start();
      await expect(db.execute("UPDATE FAIL", [])).resolves.toBe(0);
      expect(pools[0].clients[0].release).not.toHaveBeenCalled();
      await db.rollback();
      expect(pools[0].clients[0].release).toHaveBeenCalledTimes(1);
    });

    it("releases the client when COMMIT itself fails, with throwOnError on", async () => {
      PostgresDB.throwOnError = true;
      const db = new PostgresDB("postgres://a");
      await db.start();
      const client = pools[0].clients[0];
      client.query.mockImplementationOnce(() =>
        Promise.reject(new Error("commit failed")),
      );
      await expect(db.commit()).rejects.toThrow("commit failed");
      expect(client.release).toHaveBeenCalledTimes(1);
      expect(db._client).toBeUndefined();
      expect(db.transaction).toBe(false);
    });

    it("releases the client when BEGIN fails, with throwOnError on", async () => {
      PostgresDB.throwOnError = true;
      const db = new PostgresDB("postgres://a");
      const pool = (db as any).getPool();
      const connect = pool.connect.bind(pool);
      jest.spyOn(pool, "connect").mockImplementationOnce(async () => {
        const client = await connect();
        client.query.mockImplementationOnce(() =>
          Promise.reject(new Error("begin failed")),
        );
        return client;
      });
      await expect(db.start()).rejects.toThrow("begin failed");
      expect(pools[0].clients[0].release).toHaveBeenCalledTimes(1);
      expect(db.transaction).toBe(false);
    });
  });

  describe("throwOnError", () => {
    it("off (default): logs and returns undefined", async () => {
      const db = new PostgresDB("postgres://a");
      await expect(db.query("SELECT FAIL", [])).resolves.toBeUndefined();
      expect(await db.getOne("SELECT FAIL", [])).toBeNull();
      expect(await db.execute("SELECT FAIL", [])).toBe(0);
      expect(console.error).toHaveBeenCalledWith(
        "DB Exception: ",
        expect.any(Error),
      );
      expect(
        pools[0].clients.every((c) => c.release.mock.calls.length === 1),
      ).toBe(true);
    });

    it("on: rethrows", async () => {
      PostgresDB.throwOnError = true;
      const db = new PostgresDB("postgres://a");
      await expect(db.query("SELECT FAIL", [])).rejects.toThrow("boom");
      await expect(db.getOne("SELECT FAIL", [])).rejects.toThrow("boom");
      expect(console.error).not.toHaveBeenCalled();
      expect(pools[0].clients[0].release).toHaveBeenCalledTimes(1);
    });
  });
});
