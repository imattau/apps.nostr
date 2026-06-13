import { AccountManager, Accounts } from "applesauce-accounts";
import { EventStore } from "applesauce-core";
import { firstValueFrom, toArray } from "rxjs";
import { RelayPool } from "applesauce-relay";

let cachedServices = null;

export async function createNostrServices(relays) {
  if (cachedServices) {
    cachedServices.setRelays(relays);
    return cachedServices;
  }

  const relayPool = new RelayPool();
  const eventStore = new EventStore({ keepDeleted: true, keepExpired: false, keepOldVersions: false });
  const accountManager = new AccountManager();

  accountManager.registerType(Accounts.ExtensionAccount);
  accountManager.registerType(Accounts.NostrConnectAccount);

  const subscriptions = new Set();

  const services = {
    source: "applesauce",
    relayPool,
    eventStore,
    accountManager,
    signer: accountManager.signer,
    setRelays(nextRelays) {
      services.relays = uniqueRelays(nextRelays);
      if (services.liveSub) {
        services.liveSub.unsubscribe();
        services.liveSub = null;
        void services.start();
      }
    },
    onStatus(listener) {
      const sub = relayPool.status$.subscribe((statusRecord) => {
        for (const [relayUrl, status] of Object.entries(statusRecord)) {
          listener({ relayUrl, state: status, status });
        }
      });
      subscriptions.add(sub);
      return () => sub.unsubscribe();
    },
    onEvent(listener) {
      const sub = eventStore.insert$.subscribe((event) => {
        listener("applesauce", ["EVENT", "", event]);
      });
      subscriptions.add(sub);
      return () => sub.unsubscribe();
    },
    async start() {
      if (services.liveSub) return;
      const activeRelays = services.relays || uniqueRelays(relays);
      services.liveSub = relayPool.subscription(activeRelays, { kinds: [31922] }, { eventStore }).subscribe({
        next(event) {
          eventStore.add(event);
        },
      });
      subscriptions.add(services.liveSub);
    },
    async query(filter, timeoutMs = 3000) {
      try {
        const activeRelays = services.relays || uniqueRelays(relays);
        const events = await firstValueFrom(
          relayPool.request(activeRelays, filter, { eventStore, timeout: timeoutMs }).pipe(toArray()),
        );
        for (const event of events) {
          eventStore.add(event);
        }
        return events;
      } catch {
        return [];
      }
    },
    async publish(event) {
      const activeRelays = services.relays || uniqueRelays(relays);
      return relayPool.publish(activeRelays, event);
    },
    async connectExtensionAccount() {
      const account = await Accounts.ExtensionAccount.fromExtension();
      accountManager.addAccount(account);
      accountManager.setActive(account);
      return account;
    },
    dispose() {
      for (const sub of subscriptions) sub.unsubscribe();
      subscriptions.clear();
      services.liveSub = null;
    },
  };

  services.relays = uniqueRelays(relays);
  cachedServices = services;
  return services;
}

function uniqueRelays(relays) {
  return [...new Set((relays || []).map((relay) => String(relay).trim()).filter(Boolean))];
}
