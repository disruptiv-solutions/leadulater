import { getFirestore, serverTimestamp } from "firebase/firestore";
import { getFirebaseApp } from "@/lib/firebase/client";

export const db = getFirestore(getFirebaseApp());

export const nowServerTimestamp = () => serverTimestamp();

