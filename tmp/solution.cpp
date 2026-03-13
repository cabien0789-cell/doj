#include <bits/stdc++.h>
using namespace std;

#define endl '\n'
#define al 1000000
#define fi first
#define se second
#define bg begin
#define pub push_back
#define pob pop_back
#define ce cout << endl
#define For(i, a, b) for(int i = a; i <= b; i++)
typedef long long ll;
typedef vector<int> vi;
typedef vector<vector<int>> vvi;
typedef pair<int, int> pii;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    int a, b;
    cin >> a >> b;
    auto sum = [](int a, int b) {
        return a + b;
    };
    cout << sum(a, b) << endl;

    return 0;
}