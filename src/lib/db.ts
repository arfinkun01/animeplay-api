import { MongoClient, type Db } from "mongodb";

const MONGO_URI =
  process.env.MONGODB_URI ||
  "mongodb+srv://animeplay:animeplay@cluster0.6u8jm4h.mongodb.net/?appName=Cluster0";

let _client: MongoClient | null = null;
let _db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (_db) return _db;
  _client = new MongoClient(MONGO_URI, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
  });
  await _client.connect();
  _db = _client.db("animeplay");
  return _db;
}

export async function closeDb(): Promise<void> {
  if (_client) {
    await _client.close();
    _client = null;
    _db = null;
  }
}
