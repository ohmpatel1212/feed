import { initializeApp, getApps } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";
import { getFirestore, doc, setDoc, getDoc, collection, getDocs, deleteDoc, serverTimestamp } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDTWNJ0j4Wd6l9qRGDqOufu1ILy9FGZHOM",
  authDomain: "timelines-492720.firebaseapp.com",
  projectId: "timelines-492720",
  storageBucket: "timelines-492720.firebasestorage.app",
  messagingSenderId: "777152549518",
  appId: "1:777152549518:web:9c8e4bfdebe07373de2fdf",
  measurementId: "G-72NL4ZF268",
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
export const db = getFirestore(app);

// --- Firestore helpers ---

export interface FirestoreProfile {
  uid: string;
  name: string;
  email: string;
  photoURL: string;
  blueskyHandle: string;
  blueskyDid: string;
  onboardedAt: string;
}

export interface FirestoreFeed {
  id: string;
  name: string;
  color: string;
  criteria: {
    topics: string[];
    keywords: string[];
    exclude_topics: string[];
    exclude_keywords: string[];
    vibes: string;
  };
  createdAt: string;
}

// -- Profile --

export async function saveProfileToFirestore(profile: FirestoreProfile) {
  await setDoc(doc(db, "users", profile.uid), {
    ...profile,
    updatedAt: serverTimestamp(),
  }, { merge: true });
}

export async function loadProfileFromFirestore(uid: string): Promise<FirestoreProfile | null> {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? (snap.data() as FirestoreProfile) : null;
}

// -- Feeds --

export async function saveFeedToFirestore(uid: string, feed: FirestoreFeed) {
  await setDoc(doc(db, "users", uid, "feeds", feed.id), {
    ...feed,
    updatedAt: serverTimestamp(),
  });
}

export async function loadFeedsFromFirestore(uid: string): Promise<FirestoreFeed[]> {
  const snap = await getDocs(collection(db, "users", uid, "feeds"));
  return snap.docs.map(d => d.data() as FirestoreFeed);
}

export async function deleteFeedFromFirestore(uid: string, feedId: string) {
  await deleteDoc(doc(db, "users", uid, "feeds", feedId));
  // Also delete chat messages for this feed
  const msgsSnap = await getDocs(collection(db, "users", uid, "feeds", feedId, "messages"));
  for (const d of msgsSnap.docs) {
    await deleteDoc(d.ref);
  }
}

// -- Chat Messages --

export async function saveChatMessagesToFirestore(
  uid: string,
  feedId: string,
  messages: { role: string; content: string }[]
) {
  // Store as a single doc for simplicity (messages array)
  await setDoc(doc(db, "users", uid, "feeds", feedId, "chat", "history"), {
    messages,
    updatedAt: serverTimestamp(),
  });
}

export async function loadChatMessagesFromFirestore(
  uid: string,
  feedId: string
): Promise<{ role: string; content: string }[]> {
  const snap = await getDoc(doc(db, "users", uid, "feeds", feedId, "chat", "history"));
  if (!snap.exists()) return [];
  return (snap.data().messages || []) as { role: string; content: string }[];
}
