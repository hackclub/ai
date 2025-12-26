import sodium from "libsodium-wrappers";

await sodium.ready;

const keypair = sodium.crypto_box_keypair("base64");

console.log("Public key:", keypair.publicKey);
console.log("Private key:", keypair.privateKey);
console.log(
  "\nKeep these safe. If you lose the private key, you'll never be able to decrypt your data!",
);
