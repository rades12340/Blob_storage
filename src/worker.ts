declare var self: Worker;

function isPrime(n: number) {
    if (n < 2) return false;
    if (n === 2) return true;
    if (n % 2 === 0) return false;

    for (let i = 3; i * i <= n; i += 2) {
        if (n % i === 0) return false;
    }

    return true;
}

self.onmessage = (event: MessageEvent<{ limit: number }>) => {
    const { limit } = event.data;
    const start = Date.now();

    let primes = 0;
    for (let i = 2; i <= limit; i++) {
        if (isPrime(i)) primes++;
    }

    const ms = Date.now() - start;
    postMessage({ limit, primes, ms });
};
