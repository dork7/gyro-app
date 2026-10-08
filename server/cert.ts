import selfsigned from 'selfsigned';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Phone browsers only expose motion sensors on HTTPS pages, so the dev server
// uses a self-signed certificate that covers localhost and this machine's LAN IPs.
// It is cached in .certs/ and regenerated when the IPs change.

export interface Cert {
  key: string;
  cert: string;
}

export function getCert(root: string, ips: string[]): Cert {
  const dir = join(root, '.certs');
  const keyFile = join(dir, 'key.pem');
  const certFile = join(dir, 'cert.pem');
  const metaFile = join(dir, 'ips.txt');
  const wanted = [...ips].sort().join(',');

  if (existsSync(keyFile) && existsSync(certFile) && existsSync(metaFile) && readFileSync(metaFile, 'utf8') === wanted) {
    return { key: readFileSync(keyFile, 'utf8'), cert: readFileSync(certFile, 'utf8') };
  }

  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: 'commonName', value: 'gyro-fruit-slicer' }], {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'subjectAltName', altNames },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile, pems.private);
  writeFileSync(certFile, pems.cert);
  writeFileSync(metaFile, wanted);
  return { key: pems.private, cert: pems.cert };
}
