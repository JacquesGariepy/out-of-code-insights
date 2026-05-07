function preserve_a() { return 0; }
function preserve_b() { return 0; }

function targetFunction() {
    const TARGET_LINE = "anchored content";
    return TARGET_LINE;
}

function shorty() { return 1; }

export { targetFunction };
