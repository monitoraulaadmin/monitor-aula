import { ref, get, set } from 'firebase/database';
import { db } from '../config/firebase';

let adminUids = null;
let userEmailCache = {};

export const RolesService = {
  async _fetchAdminUids(uid) {
    if (!uid) return [];
    try {
      const fixedAdminRef = ref(db, `fixed_admins/${uid}`);
      const fixedAdminSnap = await get(fixedAdminRef);
      if (fixedAdminSnap.exists()) {
        return [uid];
      }

      const designatedAdminRef = ref(db, `designated_admins/${uid}`);
      const designatedAdminSnap = await get(designatedAdminRef);
      if (designatedAdminSnap.exists()) {
        return [uid];
      }

      return [];
    } catch (error) {
      this.invalidateAdminCache();
      return [];
    }
  },

  async _fetchUserEmail(uid) {
    if (userEmailCache[uid]) {
      return userEmailCache[uid];
    }
    try {
      const userRef = ref(db, `users/${uid}`);
      const snapshot = await get(userRef);
      if (snapshot.exists()) {
        const email = snapshot.val();
        userEmailCache[uid] = email;
        return email;
      }
      return null;
    } catch (error) {
      return null;
    }
  },

  async isAdmin(user) {
    try {
      if (!user || !user.uid) {
        return false;
      }

      const uids = await this._fetchAdminUids(user.uid);
      const isAdmin = uids.length > 0;
      
      if (isAdmin) {
        adminUids = uids;
      }
      
      return isAdmin;
    } catch (error) {
      return false;
    }
  },

  invalidateAdminCache() {
    adminUids = null;
    userEmailCache = {};
  },

  async addAdmin(uid) {
    if (!uid) {
      throw new Error("UID is required to add an admin.");
    }
    try {
      const designatedAdminsRef = ref(db, `designated_admins/${uid}`);
      await set(designatedAdminsRef, true);
      this.invalidateAdminCache();
    } catch (error) {
      throw error;
    }
  },

  async getLastVisitedClass(email) {
    if (!email) return null;

    try {
      const sanitizedEmail = email.replace(/[.#$[\]]/g, '_');
      const userPrefsRef = ref(db, `userPreferences/${sanitizedEmail}`);
      const snapshot = await get(userPrefsRef);
      if (snapshot.exists()) {
        const prefs = snapshot.val();
        return prefs.lastClass || null;
      }
      return null;
    } catch (error) {
      return null;
    }
  },

  async setLastVisitedClass(email, className) {
    if (!email || !className) return;

    try {
      const sanitizedEmail = email.replace(/[.#$[\]]/g, '_');
      const userPrefsRef = ref(db, `userPreferences/${sanitizedEmail}`);
      await set(userPrefsRef, {
        lastClass: className,
        lastVisit: new Date().toISOString()
      });
    } catch (error) {
    }
  }
};