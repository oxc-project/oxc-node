let argCount = -1;

function Count(...args: unknown[]): unknown {
  argCount = args.length;
  return args[0];
}

@Count
class Foo {}

void Foo;

console.log(`ARG_COUNT:${argCount}`);
