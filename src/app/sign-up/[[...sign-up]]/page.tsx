import { SignUp } from '@clerk/nextjs';

export default function SignUpPage() {
  return (
    <div className="flex flex-1 items-center justify-center px-4 py-10">
      <SignUp
        appearance={{
          elements: {
            rootBox: 'mx-auto',
          },
        }}
      />
    </div>
  );
}
